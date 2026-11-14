//go:build integration

package idempotency_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"io"
	"maps"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	idem "github.com/Koshsky/erp-backend/internal/idempotency"
)

type operationHTTP struct {
	t      *testing.T
	base   string
	client *http.Client
	admin  string
	prefix string
}

type operationHTTPReply struct {
	status int
	header http.Header
	data   json.RawMessage
}

func newOperationHTTP(t *testing.T) *operationHTTP {
	t.Helper()
	base := os.Getenv("OPERATION_TEST_API_URL")
	if base == "" {
		t.Skip("set OPERATION_TEST_API_URL and OPERATION_TEST_ADMIN_PASSWORD for disposable local API tests")
	}
	if os.Getenv("OPERATION_TEST_ISOLATED") != "1" {
		t.Fatal("operation HTTP fixtures require OPERATION_TEST_ISOLATED=1")
	}
	parsed, err := url.Parse(base)
	if err != nil || parsed.Scheme != "http" || parsed.Hostname() != "127.0.0.1" || parsed.User != nil {
		t.Fatal("operation HTTP tests require an explicit loopback HTTP fixture")
	}
	password := os.Getenv("OPERATION_TEST_ADMIN_PASSWORD")
	if password == "" {
		t.Fatal("OPERATION_TEST_ADMIN_PASSWORD is required")
	}
	a := &operationHTTP{
		t:      t,
		base:   strings.TrimRight(base, "/"),
		client: &http.Client{Timeout: operationTestTimeout},
		prefix: "op" + strings.ToLower(rand.Text()),
	}
	a.admin = a.login("admin", password)
	return a
}

func (a *operationHTTP) login(username, password string) string {
	a.t.Helper()
	body, err := json.Marshal(map[string]string{"username": username, "password": password})
	if err != nil {
		a.t.Fatal(err)
	}
	reply := a.call("", http.MethodPost, "/auth/login", "", body, nil)
	a.expect(reply, http.StatusOK)
	var data struct {
		AccessToken string `json:"access_token"`
	}
	if err = json.Unmarshal(reply.data, &data); err != nil || data.AccessToken == "" {
		a.t.Fatal("login did not return an access token")
	}
	return data.AccessToken
}

func (a *operationHTTP) call(token, method, path, id string, body []byte, extra http.Header) *operationHTTPReply {
	a.t.Helper()
	// Fixture cleanup must still reach the API after the test context is cancelled.
	ctx, cancel := context.WithTimeout(context.Background(), operationTestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, a.base+path, bytes.NewReader(body))
	if err != nil {
		a.t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if id != "" {
		req.Header.Set("Operation-Id", id)
	}
	maps.Copy(req.Header, extra)
	res, err := a.client.Do(req)
	if err != nil {
		a.t.Fatal(err)
	}
	defer res.Body.Close()
	var envelope struct {
		Data json.RawMessage `json:"data"`
	}
	if res.StatusCode != http.StatusNoContent {
		if err = json.NewDecoder(res.Body).Decode(&envelope); err != nil {
			a.t.Fatal(err)
		}
	}
	return &operationHTTPReply{status: res.StatusCode, header: res.Header, data: envelope.Data}
}

func (a *operationHTTP) expect(reply *operationHTTPReply, status int) {
	a.t.Helper()
	if reply.status != status {
		a.t.Fatalf("HTTP %d, expected %d", reply.status, status)
	}
}

func (a *operationHTTP) create(path string, body any) int64 {
	a.t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		a.t.Fatal(err)
	}
	reply := a.call(a.admin, http.MethodPost, path, "", encoded, nil)
	a.expect(reply, http.StatusCreated)
	var data struct {
		ID int64 `json:"id"`
	}
	if err = json.Unmarshal(reply.data, &data); err != nil || data.ID <= 0 {
		a.t.Fatal("missing created ID")
	}
	a.t.Cleanup(func() { a.call(a.admin, http.MethodDelete, path+"/"+strconv.FormatInt(data.ID, 10), "", nil, nil) })
	return data.ID
}

func (a *operationHTTP) worker() (int64, string) {
	a.t.Helper()
	username := a.prefix[:20]
	body, _ := json.Marshal(
		map[string]string{"username": username, "first_name": "Operation", "last_name": "Fixture", "preset": "worker"},
	)
	reply := a.call(a.admin, http.MethodPost, "/user", "", body, nil)
	a.expect(reply, http.StatusCreated)
	var data struct {
		User struct {
			ID int64 `json:"id"`
		} `json:"user"`
		Password string `json:"password"`
	}
	if err := json.Unmarshal(reply.data, &data); err != nil || data.User.ID <= 0 || data.Password == "" {
		a.t.Fatal("invalid disposable user")
	}
	a.t.Cleanup(
		func() { a.call(a.admin, http.MethodDelete, "/user/"+strconv.FormatInt(data.User.ID, 10), "", nil, nil) },
	)
	return data.User.ID, a.login(username, data.Password)
}

func operationHTTPReceipt(t *testing.T, reply *operationHTTPReply) *idem.OperationReceipt {
	t.Helper()
	var saved idem.OperationReceipt
	if err := json.Unmarshal(reply.data, &saved); err != nil {
		t.Fatal(err)
	}
	return &saved
}

func TestOperationHTTPAuthRBACAndReceiptOwnership(t *testing.T) {
	t.Parallel()
	a := newOperationHTTP(t)
	userID, worker := a.worker()
	a.expect(
		a.call(
			a.admin,
			http.MethodPost,
			"/user/"+strconv.FormatInt(userID, 10)+"/reset-password",
			a.prefix+"-reset",
			[]byte(`{}`),
			nil,
		),
		http.StatusBadRequest,
	)
	if saved := operationHTTPReceipt(
		t,
		a.call(a.admin, http.MethodGet, "/operations/"+a.prefix+"-reset", "", nil, nil),
	); saved.State != "not_found" {
		t.Fatal("credential response entered durable storage")
	}
	a.expect(
		a.call(a.admin, http.MethodPost, "/user/change-password", a.prefix+"-password", []byte(`{}`), nil),
		http.StatusBadRequest,
	)
	if saved := operationHTTPReceipt(
		t,
		a.call(a.admin, http.MethodGet, "/operations/"+a.prefix+"-password", "", nil, nil),
	); saved.State != "not_found" {
		t.Fatal("password action entered durable storage")
	}
	a.expect(a.call("", http.MethodGet, "/operations", "", nil, nil), http.StatusUnauthorized)
	a.expect(a.call("invalid-token", http.MethodGet, "/operations", "", nil, nil), http.StatusUnauthorized)
	capability := a.call(worker, http.MethodGet, "/operations", "", nil, nil)
	a.expect(capability, http.StatusOK)
	var features idem.OperationCapabilities
	if err := json.Unmarshal(capability.data, &features); err != nil || features.Protocol != 1 || !features.Durable {
		t.Fatal("durable capability handshake failed")
	}
	if !slices.Contains(features.Operations, "POST /task") || slices.Contains(features.Operations, "POST /user") {
		t.Fatal("unsafe durable route capabilities")
	}
	id := a.prefix + "-rbac"
	body, _ := json.Marshal(map[string]string{"code": a.prefix, "name": "Owned acknowledgement"})
	a.expect(a.call(worker, http.MethodPost, "/timesheet/states", id, body, nil), http.StatusForbidden)
	if got := operationHTTPReceipt(
		t,
		a.call(worker, http.MethodGet, "/operations/"+id, "", nil, nil),
	); got.State != "not_found" {
		t.Fatal("denied operation was acknowledged")
	}
	a.expect(a.call(a.admin, http.MethodPost, "/timesheet/states", id, body, nil), http.StatusCreated)
	if got := operationHTTPReceipt(
		t,
		a.call(worker, http.MethodGet, "/operations/"+id, "", nil, nil),
	); got.State != "not_found" ||
		got.Response != nil {
		t.Fatal("worker read another actor's acknowledgement")
	}
	if got := operationHTTPReceipt(
		t,
		a.call(a.admin, http.MethodGet, "/operations/"+id, "", nil, nil),
	); got.State != "confirmed" {
		t.Fatal("actor lost its acknowledgement")
	}
	a.expect(
		a.call(a.admin, http.MethodGet, "/operations/"+id+"?user_id="+strconv.FormatInt(userID, 10), "", nil, nil),
		http.StatusBadRequest,
	)
	a.expect(
		a.call(
			a.admin,
			http.MethodGet,
			"/operations/"+id,
			"",
			nil,
			http.Header{"X-View-User-Id": {strconv.FormatInt(userID, 10)}},
		),
		http.StatusForbidden,
	)
}

func (a *operationHTTP) loseCommittedResponse(path, id string, body []byte) {
	a.t.Helper()
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstream, err := http.NewRequestWithContext(r.Context(), http.MethodPost, a.base+path, bytes.NewReader(body))
		if err != nil {
			a.t.Error(err)
			return
		}
		upstream.Header.Set("Content-Type", "application/json")
		upstream.Header.Set("Authorization", "Bearer "+a.admin)
		upstream.Header.Set("Operation-Id", id)
		res, err := a.client.Do(upstream)
		if err != nil {
			a.t.Error(err)
			return
		}
		_, _ = io.Copy(io.Discard, res.Body)
		res.Body.Close()
		if res.StatusCode != http.StatusCreated {
			a.t.Error("upstream did not commit the task", res.StatusCode)
		}
		conn, _, err := w.(http.Hijacker).Hijack()
		if err == nil {
			_ = conn.Close()
		}
	}))
	req, _ := http.NewRequestWithContext(a.t.Context(), http.MethodPost, proxy.URL, nil)
	reply, err := a.client.Do(req)
	if reply != nil {
		reply.Body.Close()
	}
	proxy.Close()
	if err == nil {
		a.t.Fatal("proxy failed to discard the committed response")
	}
}

func (a *operationHTTP) taskBody() []byte {
	a.t.Helper()
	project := a.create(
		"/project",
		map[string]any{"code": a.prefix, "owner_id": 1, "start_date": "2026-11-01", "end_date": "2026-12-31"},
	)
	process := a.create(
		"/process",
		map[string]any{
			"title":      a.prefix,
			"project_id": project,
			"owner_id":   1,
			"start_date": "2026-11-01",
			"end_date":   "2026-12-31",
		},
	)
	body, _ := json.Marshal(
		map[string]any{
			"title":      a.prefix,
			"process_id": process,
			"owner_id":   1,
			"start_date": "2026-11-02",
			"end_date":   "2026-11-10",
		},
	)
	return body
}

func TestOperationHTTPLostTaskResponseAndDeleteReplay(t *testing.T) {
	t.Parallel()
	a := newOperationHTTP(t)
	body := a.taskBody()
	id := a.prefix + "-task"
	a.loseCommittedResponse("/task", id, body)
	lookup := a.call(a.admin, http.MethodGet, "/operations/"+id, "", nil, nil)
	a.expect(lookup, http.StatusOK)
	saved := operationHTTPReceipt(t, lookup)
	if saved.State != "confirmed" || saved.ResponseStatus != http.StatusCreated {
		t.Fatal("committed task receipt not found")
	}
	again := a.call(a.admin, http.MethodPost, "/task", id, body, nil)
	a.expect(again, http.StatusCreated)
	if again.header.Get("Idempotency-Replayed") != "true" {
		t.Fatal("task create executed again")
	}
	var created struct {
		ID int64 `json:"id"`
	}
	if err := json.Unmarshal(again.data, &created); err != nil || created.ID <= 0 {
		t.Fatal("task ID missing")
	}
	var envelope struct {
		Data struct {
			ID int64 `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(saved.Response, &envelope); err != nil || envelope.Data.ID != created.ID {
		t.Fatal("receipt and replay IDs differ")
	}
	list := a.call(a.admin, http.MethodGet, "/task?limit=500", "", nil, nil)
	a.expect(list, http.StatusOK)
	var tasks struct {
		Items []struct {
			ID    int64  `json:"id"`
			Title string `json:"title"`
		} `json:"items"`
	}
	if err := json.Unmarshal(list.data, &tasks); err != nil {
		t.Fatal(err)
	}
	count := 0
	for _, task := range tasks.Items {
		if task.Title == a.prefix {
			count++
		}
	}
	if count != 1 {
		t.Fatal("lost response duplicated the task", count)
	}
	target := "/task/" + strconv.FormatInt(created.ID, 10)
	a.expect(a.call(a.admin, http.MethodDelete, target, id+"-delete", nil, nil), http.StatusNoContent)
	a.expect(a.call(a.admin, http.MethodDelete, target, id+"-delete", nil, nil), http.StatusNoContent)
	a.expect(a.call(a.admin, http.MethodGet, target, "", nil, nil), http.StatusNotFound)
	a.expect(a.call(a.admin, http.MethodPost, "/task", id, body, nil), http.StatusCreated)
	a.expect(a.call(a.admin, http.MethodGet, target, "", nil, nil), http.StatusNotFound)
}

func TestOperationHTTPReceiptAcrossProcessRestart(t *testing.T) {
	t.Parallel()
	phase := os.Getenv("OPERATION_TEST_RESTART_PHASE")
	if phase != "write" && phase != "read" {
		t.Skip("set OPERATION_TEST_RESTART_PHASE around an actual isolated API restart")
	}
	a := newOperationHTTP(t)
	const id = "stage13-process-restart"
	const body = `{"code":"stage13-restart","name":"Durable restart fixture"}`
	if phase == "read" {
		lookup := a.call(a.admin, http.MethodGet, "/operations/"+id, "", nil, nil)
		a.expect(lookup, http.StatusOK)
		if operationHTTPReceipt(t, lookup).State != "confirmed" {
			t.Fatal("restart lost the receipt")
		}
	}
	again := a.call(a.admin, http.MethodPost, "/timesheet/states", id, []byte(body), nil)
	a.expect(again, http.StatusCreated)
	if phase == "read" && again.header.Get("Idempotency-Replayed") != "true" {
		t.Fatal("restart did not replay the recorded operation")
	}
}

func TestOperationHTTPTaskAndReceiptRollbackTogether(t *testing.T) {
	t.Parallel()
	a := newOperationHTTP(t)
	pool, err := pgxpool.New(t.Context(), os.Getenv("OPERATION_TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if !strings.HasPrefix(pool.Config().ConnConfig.Database, "erp_operations_") {
		t.Fatal("receipt fault injection requires the disposable operations database")
	}
	body := a.taskBody()
	id := a.prefix + "-atomic"
	constraint := "fault_" + a.prefix
	var ddl string
	err = pool.QueryRow(
		t.Context(),
		"SELECT format('ALTER TABLE operation_receipts ADD CONSTRAINT %I CHECK(operation_id <> %L) NOT VALID', $1::text, $2::text)",
		constraint,
		id,
	).Scan(&ddl)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(t.Context(), ddl); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_, _ = pool.Exec(
			context.Background(),
			"ALTER TABLE operation_receipts DROP CONSTRAINT IF EXISTS "+pgx.Identifier{constraint}.Sanitize(),
		)
	}()
	failed := a.call(a.admin, http.MethodPost, "/task", id, body, nil)
	a.expect(failed, http.StatusInternalServerError)
	list := a.call(a.admin, http.MethodGet, "/task?limit=500", "", nil, nil)
	a.expect(list, http.StatusOK)
	var tasks struct {
		Items []struct {
			Title string `json:"title"`
		} `json:"items"`
	}
	if err = json.Unmarshal(list.data, &tasks); err != nil {
		t.Fatal(err)
	}
	for _, task := range tasks.Items {
		if task.Title == a.prefix {
			t.Fatal("real task repository bypassed the receipt transaction")
		}
	}
	if _, err = pool.Exec(
		t.Context(),
		"ALTER TABLE operation_receipts DROP CONSTRAINT "+pgx.Identifier{constraint}.Sanitize(),
	); err != nil {
		t.Fatal(err)
	}
	a.expect(a.call(a.admin, http.MethodPost, "/task", id, body, nil), http.StatusCreated)
}
