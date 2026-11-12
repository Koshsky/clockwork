//go:build integration

package idempotency_test

import (
	"encoding/json"
	"maps"
	"net/http"
	"reflect"
	"strconv"
	"sync"
	"testing"

	idem "github.com/Koshsky/erp-backend/internal/idempotency"
)

type revisionHTTP struct {
	a                                *operationHTTP
	project, process, task, resource int64
}

func newRevisionHTTP(t *testing.T) *revisionHTTP {
	t.Helper()
	a := newOperationHTTP(t)
	body := a.taskBody()
	var task map[string]any
	if err := json.Unmarshal(body, &task); err != nil {
		t.Fatal(err)
	}
	process := int64(task["process_id"].(float64))
	processReply := a.call(a.admin, http.MethodGet, "/process/"+strconv.FormatInt(process, 10), "", nil, nil)
	var parent struct {
		ProjectID int64 `json:"project_id"`
	}
	if err := json.Unmarshal(processReply.data, &parent); err != nil {
		t.Fatal(err)
	}
	taskID := a.create("/task", task)
	resource := a.create("/resources", map[string]any{"title": a.prefix, "code": a.prefix, "owner_id": 1})
	return &revisionHTTP{a: a, project: parent.ProjectID, process: process, task: taskID, resource: resource}
}

func (f *revisionHTTP) path(kind string, id int64) string {
	return "/" + kind + "/" + strconv.FormatInt(id, 10)
}

func (f *revisionHTTP) read(path string) *idem.RevisionSnapshot {
	f.a.t.Helper()
	reply := f.a.call(f.a.admin, http.MethodGet, path, "", nil, http.Header{"Revision-Protocol": []string{"1"}})
	f.a.expect(reply, http.StatusOK)
	var result idem.RevisionSnapshot
	if err := json.Unmarshal(reply.data, &result); err != nil || len(result.Snapshot) == 0 || result.Revisions == nil {
		f.a.t.Fatal("invalid revision snapshot", err)
	}
	if reply.header.Get("Revision-Protocol") != "1" {
		f.a.t.Fatal("revision handshake missing")
	}
	return &result
}

func (f *revisionHTTP) body(values map[string]any, revisions map[string]string) []byte {
	f.a.t.Helper()
	values["_preconditions"] = revisions
	body, err := json.Marshal(values)
	if err != nil {
		f.a.t.Fatal(err)
	}
	return body
}

func (f *revisionHTTP) write(method, path, id string, body []byte) *operationHTTPReply {
	return f.a.call(f.a.admin, method, path, id, body, http.Header{"Revision-Protocol": []string{"1"}})
}

func TestRevisionHTTPStaleTaskCannotOverwriteNewerEdit(t *testing.T) {
	t.Parallel()
	f := newRevisionHTTP(t)
	path := f.path("task", f.task)
	baseline := f.read(path)
	first := f.body(map[string]any{"title": "first writer"}, baseline.Revisions)
	accepted := f.write(http.MethodPut, path, f.a.prefix+"-first", first)
	f.a.expect(accepted, http.StatusOK)
	second := f.body(map[string]any{"title": "stale writer"}, baseline.Revisions)
	rejected := f.write(http.MethodPut, path, f.a.prefix+"-stale", second)
	f.a.expect(rejected, http.StatusConflict)
	if rejected.header.Get("Revision-Status") != "conflict" {
		t.Fatal("missing conflict classification")
	}
	current := f.read(path)
	var value map[string]any
	_ = json.Unmarshal(current.Snapshot, &value)
	if value["title"] != "first writer" {
		t.Fatal("stale edit escaped rollback")
	}
	saved := operationHTTPReceipt(
		t,
		f.a.call(f.a.admin, http.MethodGet, "/operations/"+f.a.prefix+"-stale", "", nil, nil),
	)
	if saved.State != "not_found" {
		t.Fatal("conflict was acknowledged")
	}
}

func TestRevisionHTTPLegacyWriterInvalidatesGuard(t *testing.T) {
	t.Parallel()
	f := newRevisionHTTP(t)
	path := f.path("task", f.task)
	before := f.read(path)
	f.a.expect(f.a.call(f.a.admin, http.MethodPut, path, "", []byte(`{"title":"legacy change"}`), nil), http.StatusOK)
	f.a.expect(
		f.write(
			http.MethodPut,
			path,
			f.a.prefix+"-legacy",
			f.body(map[string]any{"title": "old baseline"}, before.Revisions),
		),
		http.StatusConflict,
	)
}

func TestRevisionHTTPConcurrentWritersHaveOneWinner(t *testing.T) {
	t.Parallel()
	f := newRevisionHTTP(t)
	path := f.path("task", f.task)
	before := f.read(path)
	statuses := make(chan int, 2)
	var group sync.WaitGroup
	for _, suffix := range []string{"a", "b"} {
		group.Go(func() {
			reply := f.write(
				http.MethodPut,
				path,
				f.a.prefix+"-"+suffix,
				f.body(map[string]any{"title": suffix}, before.Revisions),
			)
			statuses <- reply.status
		})
	}
	group.Wait()
	close(statuses)
	counts := map[int]int{}
	for status := range statuses {
		counts[status]++
	}
	if counts[http.StatusOK] != 1 || counts[http.StatusConflict] != 1 {
		t.Fatal("guard compare/write was not atomic", counts)
	}
}

func TestRevisionHTTPReplayPrecedesConflictAndDeletion(t *testing.T) {
	t.Parallel()
	f := newRevisionHTTP(t)
	path := f.path("task", f.task)
	before := f.read(path)
	body := f.body(map[string]any{"title": "accepted edit"}, before.Revisions)
	id := f.a.prefix + "-replay"
	original := f.write(http.MethodPut, path, id, body)
	f.a.expect(original, http.StatusOK)
	f.a.expect(f.a.call(f.a.admin, http.MethodDelete, path, "", nil, nil), http.StatusNoContent)
	replay := f.write(http.MethodPut, path, id, body)
	f.a.expect(replay, http.StatusOK)
	var replayData, originalData any
	_ = json.Unmarshal(replay.data, &replayData)
	_ = json.Unmarshal(original.data, &originalData)
	if replay.header.Get("Idempotency-Replayed") != "true" || !reflect.DeepEqual(replayData, originalData) {
		t.Fatal("accepted receipt became a conflict or changed its revisions")
	}
	f.a.expect(f.write(http.MethodPut, path, id+"-new", body), http.StatusNotFound)
}

func TestRevisionHTTPProjectDateShiftInvalidatesDescendants(t *testing.T) {
	t.Parallel()
	f := newRevisionHTTP(t)
	path := f.path("task", f.task)
	before := f.read(path)
	f.a.expect(
		f.a.call(
			f.a.admin,
			http.MethodPut,
			f.path("project", f.project),
			"",
			[]byte(`{"start_date":"2026-11-03"}`),
			nil,
		),
		http.StatusOK,
	)
	f.a.expect(
		f.write(
			http.MethodPut,
			path,
			f.a.prefix+"-shift",
			f.body(map[string]any{"title": "stale nested edit"}, before.Revisions),
		),
		http.StatusConflict,
	)
}

func TestRevisionHTTPDifferentTasksShareStrictProcessBaseline(t *testing.T) {
	t.Parallel()
	f := newRevisionHTTP(t)
	path := f.path("task", f.task)
	before := f.read(path)
	sibling := f.a.create(
		"/task",
		map[string]any{
			"title":      "sibling",
			"process_id": f.process,
			"owner_id":   1,
			"start_date": "2026-11-11",
			"end_date":   "2026-11-12",
		},
	)
	f.a.expect(
		f.write(
			http.MethodPut,
			path,
			f.a.prefix+"-sibling",
			f.body(map[string]any{"title": "strict conflict"}, before.Revisions),
		),
		http.StatusConflict,
	)
	f.a.expect(f.a.call(f.a.admin, http.MethodGet, f.path("task", sibling), "", nil, nil), http.StatusOK)
}

func TestRevisionHTTPResourceMembershipInvalidatesResource(t *testing.T) {
	t.Parallel()
	f := newRevisionHTTP(t)
	user, _ := f.a.worker()
	path := f.path("resources", f.resource)
	before := f.read(path)
	body, _ := json.Marshal(map[string]any{"user_id": user})
	reply := f.a.call(f.a.admin, http.MethodPost, path+"/members", "", body, nil)
	if reply.status != http.StatusOK && reply.status != http.StatusCreated && reply.status != http.StatusNoContent {
		t.Fatal("member fixture failed", reply.status)
	}
	f.a.expect(
		f.write(
			http.MethodPut,
			path,
			f.a.prefix+"-member",
			f.body(map[string]any{"title": "stale resource"}, before.Revisions),
		),
		http.StatusConflict,
	)
}

func TestRevisionHTTPAssignmentRequiresBothResourceAndProcess(t *testing.T) {
	t.Parallel()
	f := newRevisionHTTP(t)
	before := f.read(f.path("task", f.task))
	body := f.body(map[string]any{"task_id": f.task, "resource_id": f.resource, "quantity": 1}, before.Revisions)
	f.a.expect(f.write(http.MethodPost, "/assignment", f.a.prefix+"-missing-resource", body), http.StatusConflict)
	tokens := f.read(f.path("resources", f.resource)).Revisions
	maps.Copy(tokens, before.Revisions)
	body = f.body(map[string]any{"task_id": f.task, "resource_id": f.resource, "quantity": 1}, tokens)
	accepted := f.write(http.MethodPost, "/assignment", f.a.prefix+"-assignment", body)
	f.a.expect(accepted, http.StatusCreated)
	var result idem.RevisionSnapshot
	_ = json.Unmarshal(accepted.data, &result)
	if result.Revisions["process:"+strconv.FormatInt(f.process, 10)] == tokens["process:"+strconv.FormatInt(f.process, 10)] {
		t.Fatal("assignment acknowledgement did not advance process revision")
	}
}

func TestRevisionHTTPDayChangesAndStateCatalogAreGuarded(t *testing.T) {
	t.Parallel()
	f := newRevisionHTTP(t)
	user, _ := f.a.worker()
	path := f.path("user", user) + "/days"
	state := f.a.create(
		"/timesheet/states",
		map[string]any{"code": f.a.prefix, "name": "Absence", "is_available": false},
	)
	before := f.read(path + "?start_date=2026-11-01&end_date=2026-11-30")
	body := f.body(
		map[string]any{"state_id": state, "start_date": "2026-11-04", "end_date": "2026-11-05"},
		before.Revisions,
	)
	f.a.expect(f.write(http.MethodPut, path, f.a.prefix+"-days", body), http.StatusOK)
	f.a.expect(f.write(http.MethodPut, path, f.a.prefix+"-days-stale", body), http.StatusConflict)
	fresh := f.read(path + "?start_date=2026-11-01&end_date=2026-11-30")
	f.a.expect(
		f.a.call(
			f.a.admin,
			http.MethodPut,
			f.path("timesheet/states", state),
			"",
			[]byte(`{"name":"Changed kind"}`),
			nil,
		),
		http.StatusOK,
	)
	f.a.expect(
		f.write(
			http.MethodDelete,
			path+"?start_date=2026-11-04&end_date=2026-11-05",
			f.a.prefix+"-kind",
			f.body(map[string]any{}, fresh.Revisions),
		),
		http.StatusConflict,
	)
}

func TestRevisionHTTPPermissionDenialRemainsForbidden(t *testing.T) {
	t.Parallel()
	f := newRevisionHTTP(t)
	_, worker := f.a.worker()
	path := f.path("task", f.task)
	before := f.read(path)
	reply := f.a.call(
		worker,
		http.MethodPut,
		path,
		f.a.prefix+"-denied",
		f.body(map[string]any{"title": "forbidden"}, before.Revisions),
		http.Header{"Revision-Protocol": []string{"1"}},
	)
	f.a.expect(reply, http.StatusForbidden)
}

func TestRevisionHTTPInvalidOptInNeverFallsBackToLegacy(t *testing.T) {
	t.Parallel()
	for name, test := range map[string]struct {
		header http.Header
		body   string
		id     bool
	}{
		"missing conditions": {http.Header{"Revision-Protocol": []string{"1"}}, `{"title":"bad"}`, true},
		"null conditions":    {http.Header{"Revision-Protocol": []string{"1"}}, `{"title":"bad","_preconditions":null}`, true},
		"missing operation":  {http.Header{"Revision-Protocol": []string{"1"}}, `{"title":"bad","_preconditions":{}}`, false},
		"missing protocol":   {nil, `{"title":"bad","_preconditions":{}}`, true},
		"duplicate protocol": {http.Header{"Revision-Protocol": []string{"1", "1"}}, `{"title":"bad","_preconditions":{}}`, true},
		"unknown protocol":   {http.Header{"Revision-Protocol": []string{"2"}}, `{"title":"bad","_preconditions":{}}`, true},
		"invalid key":        {http.Header{"Revision-Protocol": []string{"1"}}, `{"title":"bad","_preconditions":{"process:-1":"x"}}`, true},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			f := newRevisionHTTP(t)
			id := ""
			if test.id {
				id = f.a.prefix + "-invalid"
			}
			f.a.expect(
				f.a.call(f.a.admin, http.MethodPut, f.path("task", f.task), id, []byte(test.body), test.header),
				http.StatusBadRequest,
			)
		})
	}
}

//nolint:paralleltest // Global collection comparisons must finish before parallel HTTP fixtures mutate them.
func TestRevisionHTTPReadWrappersPreserveLegacyShapes(t *testing.T) {
	f := newRevisionHTTP(t)
	for _, path := range []string{"/planning/projects", "/planning/processes", "/planning/tasks", "/resources?limit=500", "/timesheet/states", f.path("resources", f.resource) + "/members"} {
		legacy := f.a.call(f.a.admin, http.MethodGet, path, "", nil, nil)
		f.a.expect(legacy, http.StatusOK)
		wrapped := f.read(path)
		if string(legacy.data) != string(wrapped.Snapshot) {
			t.Fatal("revision opt-in changed original data", path)
		}
	}
}

func TestRevisionHTTPAcknowledgementAdvancesOnlyAcceptedBaseline(t *testing.T) {
	t.Parallel()
	f := newRevisionHTTP(t)
	path := f.path("task", f.task)
	before := f.read(path)
	body := f.body(map[string]any{"title": "first"}, before.Revisions)
	id := f.a.prefix + "-accepted"
	accepted := f.write(http.MethodPut, path, id, body)
	f.a.expect(accepted, http.StatusOK)
	var snapshot idem.RevisionSnapshot
	if err := json.Unmarshal(accepted.data, &snapshot); err != nil {
		t.Fatal(err)
	}
	nextBody := f.body(map[string]any{"title": "next"}, snapshot.Revisions)
	f.a.expect(f.write(http.MethodPut, path, id+"-next", nextBody), http.StatusOK)
	f.a.expect(
		f.write(http.MethodPut, path, id, f.body(map[string]any{"title": "first"}, snapshot.Revisions)),
		http.StatusConflict,
	)
}

func TestRevisionHTTPGuardedDeleteReturnsNewTokens(t *testing.T) {
	t.Parallel()
	f := newRevisionHTTP(t)
	path := f.path("task", f.task)
	before := f.read(path)
	reply := f.write(http.MethodDelete, path, f.a.prefix+"-delete", f.body(map[string]any{}, before.Revisions))
	f.a.expect(reply, http.StatusOK)
	var snapshot idem.RevisionSnapshot
	if err := json.Unmarshal(reply.data, &snapshot); err != nil {
		t.Fatal(err)
	}
	key := "process:" + strconv.FormatInt(f.process, 10)
	if snapshot.Revisions[key] == "" || snapshot.Revisions[key] == before.Revisions[key] {
		t.Fatal("delete did not return advanced aggregate")
	}
}

func TestRevisionHTTPRootCreatesReturnNewAggregateTokens(t *testing.T) {
	t.Parallel()
	f := newRevisionHTTP(t)
	for _, test := range []struct {
		path, kind string
		values     map[string]any
	}{
		{"/project", "project", map[string]any{"code": f.a.prefix + "-root", "owner_id": 1, "start_date": "2026-11-01", "end_date": "2026-12-31"}},
		{"/resources", "resource", map[string]any{"code": f.a.prefix + "-root", "title": "New root", "owner_id": 1}},
	} {
		reply := f.write(
			http.MethodPost,
			test.path,
			f.a.prefix+"-root-"+test.kind,
			f.body(test.values, map[string]string{}),
		)
		f.a.expect(reply, http.StatusCreated)
		var snapshot idem.RevisionSnapshot
		_ = json.Unmarshal(reply.data, &snapshot)
		var created struct {
			ID int64 `json:"id"`
		}
		_ = json.Unmarshal(snapshot.Snapshot, &created)
		if created.ID <= 0 || snapshot.Revisions[test.kind+":"+strconv.FormatInt(created.ID, 10)] == "" {
			t.Fatal("root create missing baseline")
		}
		f.a.t.Cleanup(
			func() { f.a.call(f.a.admin, http.MethodDelete, f.path(test.path[1:], created.ID), "", nil, nil) },
		)
	}
}

func TestRevisionHTTPReordersRequireCurrentAggregate(t *testing.T) {
	t.Parallel()
	f := newRevisionHTTP(t)
	for _, test := range []struct {
		path, field, read string
		parent, id        int64
	}{
		{"/task/order", "process_id", f.path("process", f.process), f.process, f.task},
		{"/process/order", "project_id", f.path("project", f.project), f.project, f.process},
	} {
		baseline := f.read(test.read)
		body := f.body(map[string]any{test.field: test.parent, "ids": []int64{test.id}}, baseline.Revisions)
		f.a.expect(f.write(http.MethodPut, test.path, f.a.prefix+test.field, body), http.StatusOK)
		f.a.expect(f.write(http.MethodPut, test.path, f.a.prefix+test.field+"-stale", body), http.StatusConflict)
	}
}

func TestRevisionHTTPProcessReparentRequiresDestinationBaseline(t *testing.T) {
	t.Parallel()
	f := newRevisionHTTP(t)
	target := f.a.create(
		"/project",
		map[string]any{
			"code":       f.a.prefix + "-destination",
			"owner_id":   1,
			"start_date": "2026-11-01",
			"end_date":   "2026-12-31",
		},
	)
	path := f.path("process", f.process)
	before := f.read(path)
	delete(before.Revisions, "project:"+strconv.FormatInt(f.project, 10))
	body := f.body(map[string]any{"project_id": target}, before.Revisions)
	f.a.expect(f.write(http.MethodPut, path, f.a.prefix+"-destination-missing", body), http.StatusConflict)
	destination := f.read(f.path("project", target))
	maps.Copy(before.Revisions, destination.Revisions)
	f.a.expect(
		f.write(
			http.MethodPut,
			path,
			f.a.prefix+"-destination",
			f.body(map[string]any{"project_id": target}, before.Revisions),
		),
		http.StatusOK,
	)
}

func TestRevisionHTTPMilestoneAndDependencyShareProcessGuard(t *testing.T) {
	t.Parallel()
	f := newRevisionHTTP(t)
	baseline := f.read(f.path("process", f.process))
	milestone := f.write(
		http.MethodPost,
		"/milestone",
		f.a.prefix+"-milestone",
		f.body(
			map[string]any{
				"title":      "Point",
				"content":    "Milestone fixture",
				"date":       "2026-11-15",
				"process_id": f.process,
			},
			baseline.Revisions,
		),
	)
	f.a.expect(milestone, http.StatusCreated)
	f.a.expect(
		f.write(
			http.MethodPut,
			f.path("task", f.task),
			f.a.prefix+"-milestone-stale",
			f.body(map[string]any{"title": "stale"}, baseline.Revisions),
		),
		http.StatusConflict,
	)
	successor := f.a.create(
		"/task",
		map[string]any{
			"title":      "Successor",
			"owner_id":   1,
			"process_id": f.process,
			"start_date": "2026-11-20",
			"end_date":   "2026-11-21",
		},
	)
	fresh := f.read(f.path("task", successor))
	reply := f.write(
		http.MethodPost,
		f.path("task", successor)+"/dependencies",
		f.a.prefix+"-dependency",
		f.body(map[string]any{"depends_on_task_id": f.task, "type": "fs"}, fresh.Revisions),
	)
	f.a.expect(reply, http.StatusCreated)
	f.a.expect(
		f.write(
			http.MethodPut,
			f.path("task", f.task),
			f.a.prefix+"-dependency-stale",
			f.body(map[string]any{"title": "stale"}, fresh.Revisions),
		),
		http.StatusConflict,
	)
}

func TestRevisionHTTPOwnershipChangeCannotResurrectAssignment(t *testing.T) {
	t.Parallel()
	f := newRevisionHTTP(t)
	user, _ := f.a.worker()
	assignment := f.a.create("/assignment", map[string]any{"task_id": f.task, "resource_id": f.resource, "quantity": 1})
	path := f.path("assignment", assignment)
	before := f.read(path)
	change, _ := json.Marshal(map[string]any{"owner_id": user})
	f.a.expect(f.a.call(f.a.admin, http.MethodPut, f.path("resources", f.resource), "", change, nil), http.StatusOK)
	f.a.expect(
		f.write(http.MethodPut, path, f.a.prefix+"-owner", f.body(map[string]any{"quantity": 2}, before.Revisions)),
		http.StatusNotFound,
	)
	f.a.expect(f.a.call(f.a.admin, http.MethodGet, path, "", nil, nil), http.StatusNotFound)
}

func TestRevisionHTTPRevokedRightsBlockNewIntentButNotAcceptedReceipt(t *testing.T) {
	t.Parallel()
	f := newRevisionHTTP(t)
	user, token := f.a.worker()
	setOwner, _ := json.Marshal(map[string]any{"owner_id": user})
	f.a.expect(f.a.call(f.a.admin, http.MethodPut, f.path("process", f.process), "", setOwner, nil), http.StatusOK)
	f.a.expect(
		f.a.call(f.a.admin, http.MethodPut, f.path("user", user), "", []byte(`{"preset":"vp"}`), nil),
		http.StatusOK,
	)
	path := f.path("task", f.task)
	header := http.Header{"Revision-Protocol": []string{"1"}}
	read := f.a.call(token, http.MethodGet, path, "", nil, header)
	f.a.expect(read, http.StatusOK)
	var before idem.RevisionSnapshot
	if err := json.Unmarshal(read.data, &before); err != nil {
		t.Fatal(err)
	}
	body := f.body(map[string]any{"title": "accepted by former process owner"}, before.Revisions)
	id := f.a.prefix + "-rights"
	f.a.expect(f.a.call(token, http.MethodPut, path, id, body, header), http.StatusOK)
	f.a.expect(
		f.a.call(f.a.admin, http.MethodPut, f.path("user", user), "", []byte(`{"preset":"worker"}`), nil),
		http.StatusOK,
	)
	f.a.expect(f.a.call(token, http.MethodPut, path, id+"-new", body, header), http.StatusForbidden)
	replay := f.a.call(token, http.MethodPut, path, id, body, header)
	f.a.expect(replay, http.StatusOK)
	if replay.header.Get("Idempotency-Replayed") != "true" {
		t.Fatal("rights revocation hid accepted historical acknowledgement")
	}
}
