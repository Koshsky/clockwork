package engine_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"maps"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

type accessHTTP struct {
	t        *testing.T
	base     string
	client   *http.Client
	admin    string
	token    string
	actor    int64
	other    int64
	serial   int
	prefix   string
	requests int
}

type accessReply struct {
	status int
	data   map[string]any
}

type accessObject struct {
	path        string
	scope       string
	own         int64
	foreign     int64
	ownBody     map[string]any
	foreignBody map[string]any
	patch       map[string]any
}

//nolint:paralleltest // Exercises one local API and shared rate-limit bucket with disposable fixtures.
func TestHTTPPermissionActions(t *testing.T) {
	api := newAccessHTTP(t)
	objects := api.objects()
	for _, object := range objects {
		for _, mode := range []string{"none", "scoped", "all"} {
			for _, action := range []string{"view", "create", "update", "delete"} {
				t.Run(object.path+"/"+action+"/"+mode, func(t *testing.T) {
					previous := api.t
					api.t = t
					defer func() { api.t = previous }()
					api.setPermission(object, action, mode)
					api.checkAction(object, action, mode)
				})
			}
		}
	}
	api.checkOwnershipForgery(objects)
	api.checkImmediateRevocation(objects)
	t.Logf(
		"%d real HTTP requests; one preset, isolated action grants, scoped/all/none, direct IDs and lists",
		api.requests,
	)
}

func newAccessHTTP(t *testing.T) *accessHTTP {
	t.Helper()
	base := os.Getenv("RBAC_TEST_API_URL")
	if base == "" {
		t.Skip("set RBAC_TEST_API_URL and RBAC_TEST_ADMIN_PASSWORD for local HTTP integration tests")
	}
	parsed, err := url.Parse(base)
	if err != nil {
		t.Fatal(err)
	}
	host := parsed.Hostname()
	if (host != "127.0.0.1" && host != "localhost" && host != "::1") || parsed.User != nil {
		t.Fatal("RBAC HTTP fixtures require a loopback API")
	}
	password := os.Getenv("RBAC_TEST_ADMIN_PASSWORD")
	if password == "" {
		t.Fatal("RBAC_TEST_ADMIN_PASSWORD is required")
	}
	api := &accessHTTP{t: t, base: strings.TrimRight(base, "/"), client: &http.Client{Timeout: 10 * time.Second},
		prefix: "rbac" + strconv.FormatInt(time.Now().UnixNano(), 36)}
	login := api.call("", http.MethodPost, "auth/login", map[string]any{"username": "admin", "password": password})
	api.expect(login, http.StatusOK, "administrator login")
	api.admin = textValue(login.data, "access_token")
	api.actor, api.token = api.user("actor")
	api.other, _ = api.user("other")
	return api
}

func (a *accessHTTP) call(token, method, path string, body any) *accessReply {
	a.t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		a.t.Fatal(err)
	}
	for range 8 {
		request, makeErr := http.NewRequestWithContext(
			context.Background(),
			method,
			a.base+"/"+path,
			bytes.NewReader(encoded),
		)
		if makeErr != nil {
			a.t.Fatal(makeErr)
		}
		request.Header.Set("Content-Type", "application/json")
		if token != "" {
			request.Header.Set("Authorization", "Bearer "+token)
		}
		response, callErr := a.client.Do(request)
		if callErr != nil {
			a.t.Fatal(callErr)
		}
		a.requests++
		content, readErr := io.ReadAll(response.Body)
		_ = response.Body.Close()
		if readErr != nil {
			a.t.Fatal(readErr)
		}
		if response.StatusCode == http.StatusTooManyRequests {
			time.Sleep(time.Second)
			continue
		}
		var envelope struct {
			Data map[string]any `json:"data"`
		}
		if len(content) > 0 {
			if err = json.Unmarshal(content, &envelope); err != nil {
				a.t.Fatalf("%s %s returned an invalid envelope", method, path)
			}
		}
		return &accessReply{status: response.StatusCode, data: envelope.Data}
	}
	a.t.Fatal("local API rate limit did not recover")
	return nil
}

func (a *accessHTTP) expect(reply *accessReply, status int, operation string) {
	a.t.Helper()
	if reply.status != status {
		a.t.Fatalf("%s: HTTP %d, want %d", operation, reply.status, status)
	}
}

func (a *accessHTTP) name() string                     { a.serial++; return fmt.Sprintf("%s-%d", a.prefix, a.serial) }
func textValue(data map[string]any, key string) string { value, _ := data[key].(string); return value }
func idValue(data map[string]any, key string) int64 {
	value, _ := data[key].(float64)
	return int64(value)
}

func (a *accessHTTP) user(label string) (int64, string) {
	a.t.Helper()
	username := strings.ReplaceAll(a.name(), "-", "_")
	reply := a.call(a.admin, http.MethodPost, "user", map[string]any{
		"username": username, "first_name": "RBAC", "last_name": label, "preset": "worker",
	})
	a.expect(reply, http.StatusCreated, "create disposable user")
	user, _ := reply.data["user"].(map[string]any)
	id := idValue(user, "id")
	if id == 0 {
		a.t.Fatal("user ID missing")
	}
	a.t.Cleanup(func() { a.call(a.admin, http.MethodDelete, fmt.Sprintf("user/%d", id), nil) })
	login := a.call("", http.MethodPost, "auth/login", map[string]any{
		"username": username, "password": textValue(reply.data, "password"),
	})
	a.expect(login, http.StatusOK, "fixture login")
	return id, textValue(login.data, "access_token")
}

func (a *accessHTTP) create(path string, body map[string]any) int64 {
	a.t.Helper()
	reply := a.call(a.admin, http.MethodPost, path, body)
	a.expect(reply, http.StatusCreated, "fixture "+path)
	id := idValue(reply.data, "id")
	if id == 0 {
		a.t.Fatal("fixture ID missing: " + path)
	}
	a.t.Cleanup(func() { a.call(a.admin, http.MethodDelete, fmt.Sprintf("%s/%d", path, id), nil) })
	return id
}

func (a *accessHTTP) dated(values map[string]any) map[string]any {
	body := map[string]any{"start_date": "2026-11-01", "end_date": "2026-12-31", "title": a.name()}
	maps.Copy(body, values)
	return body
}

func (a *accessHTTP) objects() []*accessObject {
	ownProject := a.create("project", a.dated(map[string]any{"owner_id": a.actor, "code": a.name()}))
	otherProject := a.create("project", a.dated(map[string]any{"owner_id": a.other, "code": a.name()}))
	// Auto-created process templates must not affect exact scoped list assertions.
	a.clearGeneratedProcesses(ownProject, otherProject)
	ownProcess := a.create("process", a.dated(map[string]any{"owner_id": a.actor, "project_id": ownProject}))
	otherProcess := a.create("process", a.dated(map[string]any{"owner_id": a.other, "project_id": otherProject}))
	ownTask := a.create("task", a.dated(map[string]any{"owner_id": a.actor, "process_id": ownProcess}))
	otherTask := a.create("task", a.dated(map[string]any{"owner_id": a.other, "process_id": otherProcess}))
	ownResource := a.create("resources", map[string]any{"owner_id": a.actor, "code": a.name(), "title": a.name()})
	otherResource := a.create("resources", map[string]any{"owner_id": a.other, "code": a.name(), "title": a.name()})
	return []*accessObject{
		{
			path:    "project",
			scope:   "self",
			own:     ownProject,
			foreign: otherProject,
			ownBody: a.dated(map[string]any{"owner_id": a.actor, "code": a.name()}),
			foreignBody: a.dated(
				map[string]any{"owner_id": a.other, "code": a.name()},
			),
			patch: map[string]any{"code": a.name()},
		},
		{
			path:    "process",
			scope:   "project_owner",
			own:     ownProcess,
			foreign: otherProcess,
			ownBody: a.dated(map[string]any{"owner_id": a.actor, "project_id": ownProject}),
			foreignBody: a.dated(
				map[string]any{"owner_id": a.other, "project_id": otherProject},
			),
			patch: map[string]any{"title": a.name()},
		},
		{
			path:    "task",
			scope:   "process_owner",
			own:     ownTask,
			foreign: otherTask,
			ownBody: a.dated(map[string]any{"owner_id": a.actor, "process_id": ownProcess}),
			foreignBody: a.dated(
				map[string]any{"owner_id": a.other, "process_id": otherProcess},
			),
			patch: map[string]any{"title": a.name()},
		},
		{
			path:  "milestone",
			scope: "process_owner",
			own: a.create(
				"milestone",
				map[string]any{
					"process_id": ownProcess,
					"date":       "2026-11-20",
					"title":      a.name(),
					"content":    "RBAC fixture",
				},
			),
			foreign: a.create(
				"milestone",
				map[string]any{
					"process_id": otherProcess,
					"date":       "2026-11-20",
					"title":      a.name(),
					"content":    "RBAC fixture",
				},
			),
			ownBody: map[string]any{
				"process_id": ownProcess,
				"date":       "2026-11-20",
				"title":      a.name(),
				"content":    "RBAC fixture",
			},
			foreignBody: map[string]any{
				"process_id": otherProcess,
				"date":       "2026-11-20",
				"title":      a.name(),
				"content":    "RBAC fixture",
			},
			patch: map[string]any{"title": a.name()},
		},
		{
			path:  "assignment",
			scope: "process_owner",
			own: a.create(
				"assignment",
				map[string]any{"task_id": ownTask, "resource_id": ownResource, "quantity": 1},
			),
			foreign: a.create(
				"assignment",
				map[string]any{"task_id": otherTask, "resource_id": otherResource, "quantity": 1},
			),
			ownBody: map[string]any{
				"task_id":     ownTask,
				"resource_id": ownResource,
				"quantity":    1,
				"process_id":  ownProcess,
			},
			foreignBody: map[string]any{
				"task_id":     otherTask,
				"resource_id": otherResource,
				"quantity":    1,
				"process_id":  otherProcess,
			},
			patch: map[string]any{"quantity": 2},
		},
		{
			path:    "resources",
			scope:   "self",
			own:     ownResource,
			foreign: otherResource,
			ownBody: map[string]any{"owner_id": a.actor, "code": a.name(), "title": a.name()},
			foreignBody: map[string]any{
				"owner_id": a.other,
				"code":     a.name(),
				"title":    a.name(),
			},
			patch: map[string]any{"title": a.name()},
		},
	}
}

func (a *accessHTTP) clearGeneratedProcesses(projectIDs ...int64) {
	for offset := 0; ; offset += 500 {
		reply := a.call(a.admin, http.MethodGet, fmt.Sprintf("process?limit=500&offset=%d", offset), nil)
		a.expect(reply, http.StatusOK, "list generated process fixtures")
		items, _ := reply.data["items"].([]any)
		for _, item := range items {
			row, _ := item.(map[string]any)
			for _, projectID := range projectIDs {
				if idValue(row, "project_id") == projectID {
					a.call(a.admin, http.MethodDelete, fmt.Sprintf("process/%d", idValue(row, "id")), nil)
				}
			}
		}
		if len(items) < 500 {
			return
		}
	}
}

func permissionResource(path string) string {
	if path == "resources" {
		return "resource"
	}
	return path
}
func (a *accessHTTP) setPermission(object *accessObject, action, mode string) {
	scope := object.scope
	if mode == "all" {
		scope = "all"
	}
	rules := []map[string]any{
		{"resource": permissionResource(object.path), "action": action, "scope": scope, "granted": mode != "none"},
	}
	if object.path == "assignment" && action != "view" && mode != "none" {
		rules = append(rules, map[string]any{"resource": "task", "action": "view", "scope": scope, "granted": true})
	}
	a.replacePermissions(rules)
}
func (a *accessHTTP) replacePermissions(rules []map[string]any) {
	a.expect(a.call(a.admin, http.MethodPut, fmt.Sprintf("rbac/users/%d/permissions", a.actor),
		map[string]any{"overrides": rules}), http.StatusOK, "replace fixture permissions")
}

func (a *accessHTTP) checkAction(object *accessObject, action, mode string) {
	if action == "view" {
		a.checkRead(object, mode)
		return
	}
	for _, foreign := range []bool{false, true} {
		allowed := mode == "all" || (mode == "scoped" && !foreign)
		id, body := object.own, object.ownBody
		if foreign {
			id, body = object.foreign, object.foreignBody
		}
		a.checkWrite(object, action, foreign, allowed, id, body)
	}
}

func (a *accessHTTP) checkWrite(
	object *accessObject,
	action string,
	foreign, allowed bool,
	id int64,
	body map[string]any,
) {
	body = cloneAccessBody(body)
	switch action {
	case "create":
		if allowed {
			body = a.freshBody(object.path, body)
		}
		reply := a.call(a.token, http.MethodPost, object.path, body)
		status := http.StatusForbidden
		if allowed {
			status = http.StatusCreated
		}
		a.expect(reply, status, object.path+" create "+strconv.FormatBool(foreign))
		if allowed {
			a.expect(
				a.call(a.admin, http.MethodDelete, fmt.Sprintf("%s/%d", object.path, idValue(reply.data, "id")), nil),
				http.StatusNoContent,
				"remove created fixture",
			)
		}
	case "update":
		patch := cloneAccessBody(object.patch)
		if _, ok := patch["title"]; ok {
			patch["title"] = a.name()
		}
		if _, ok := patch["code"]; ok {
			patch["code"] = a.name()
		}
		reply := a.call(a.token, http.MethodPut, fmt.Sprintf("%s/%d", object.path, id), patch)
		status := http.StatusForbidden
		if allowed {
			status = http.StatusOK
		}
		a.expect(reply, status, object.path+" update "+strconv.FormatBool(foreign))
	case "delete":
		if allowed {
			id = a.create(object.path, a.freshBody(object.path, body))
		}
		reply := a.call(a.token, http.MethodDelete, fmt.Sprintf("%s/%d", object.path, id), nil)
		status := http.StatusForbidden
		if allowed {
			status = http.StatusNoContent
		}
		a.expect(reply, status, object.path+" delete "+strconv.FormatBool(foreign))
	}
}

func cloneAccessBody(body map[string]any) map[string]any {
	return maps.Clone(body)
}
func (a *accessHTTP) freshBody(path string, body map[string]any) map[string]any {
	body = cloneAccessBody(body)
	if path == "project" || path == "resources" {
		body["code"] = a.name()
	}
	if path != "assignment" {
		body["title"] = a.name()
	}
	if path == "assignment" {
		body["task_id"] = a.create("task", a.dated(map[string]any{"process_id": body["process_id"]}))
		delete(body, "process_id")
	}
	return body
}

func (a *accessHTTP) checkRead(object *accessObject, mode string) {
	for _, foreign := range []bool{false, true} {
		id := object.own
		if foreign {
			id = object.foreign
		}
		status := http.StatusNotFound
		if mode == "all" || (mode == "scoped" && !foreign) {
			status = http.StatusOK
		}
		a.expect(
			a.call(a.token, http.MethodGet, fmt.Sprintf("%s/%d", object.path, id), nil),
			status,
			"direct "+object.path,
		)
	}
	reply := a.call(a.token, http.MethodGet, object.path+"?limit=500", nil)
	if mode == "none" {
		a.expect(reply, http.StatusForbidden, "denied list "+object.path)
		return
	}
	a.expect(reply, http.StatusOK, "scoped list "+object.path)
	items, _ := reply.data["items"].([]any)
	seen := map[int64]bool{}
	for _, item := range items {
		row, _ := item.(map[string]any)
		seen[idValue(row, "id")] = true
	}
	if !seen[object.own] || seen[object.foreign] != (mode == "all") {
		a.t.Fatalf("%s list leaked or hid fixture rows", object.path)
	}
	if mode == "scoped" && idValue(reply.data, "total") != 1 {
		a.t.Fatalf("%s scoped count does not match its list", object.path)
	}
}

func (a *accessHTTP) checkOwnershipForgery(objects []*accessObject) {
	for _, object := range objects {
		a.setPermission(object, "create", "scoped")
		forged := cloneAccessBody(object.foreignBody)
		if object.path != "project" && object.path != "resources" {
			forged["owner_id"] = a.actor
		}
		a.expect(
			a.call(a.token, http.MethodPost, object.path, forged),
			http.StatusForbidden,
			"foreign parent or owner forgery "+object.path,
		)
	}
	assignment := objects[4]
	a.setPermission(assignment, "create", "all")
	forged := cloneAccessBody(assignment.ownBody)
	forged["resource_id"] = assignment.foreignBody["resource_id"]
	a.expect(a.call(a.token, http.MethodPost, "assignment", forged), http.StatusForbidden, "assignment owner invariant")
}

func (a *accessHTTP) checkImmediateRevocation(objects []*accessObject) {
	project := objects[0]
	a.setPermission(project, "update", "all")
	a.expect(
		a.call(a.token, http.MethodPut, fmt.Sprintf("project/%d", project.foreign), project.patch),
		http.StatusOK,
		"grant takes effect with existing JWT",
	)
	a.replacePermissions(nil)
	a.expect(
		a.call(a.token, http.MethodPut, fmt.Sprintf("project/%d", project.foreign), project.patch),
		http.StatusForbidden,
		"revocation takes effect with existing JWT",
	)
	for _, object := range objects {
		a.expect(
			a.call("", http.MethodGet, object.path, nil),
			http.StatusUnauthorized,
			"unauthenticated list "+object.path,
		)
	}
}
