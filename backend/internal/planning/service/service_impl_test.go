//nolint:testpackage // service tests build PlanningService directly over a stub repository (unexported fields)
package service

import (
	"context"
	"log/slog"
	"slices"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	"github.com/Koshsky/erp-backend/internal/planning/dto"
	"github.com/Koshsky/erp-backend/internal/planning/repository/sqlc"
	"github.com/Koshsky/erp-backend/internal/tracing"
)

// lsAll/lsOwn/lsNone/lsParent/lsAncestor — compiled scope bundles for tests.
func lsAll() rbac.ListScope  { return rbac.ListScope{All: true} }
func lsOwn() rbac.ListScope  { return rbac.ListScope{Self: true} }
func lsNone() rbac.ListScope { return rbac.ListScope{None: true} }

// stubPlanningRepo is an in-memory PlanningRepository. The two scoped list
// methods apply the scoping contract of the SQL queries (filterProjects /
// filterResources): 'all' returns everything, 'own' keeps rows owned by the
// caller, and an empty zone (no rule / none — the engine code for a missing
// matrix row) includes all rows so the visible primary entities still render.
// Every call records the scoping parameters it received.
type stubPlanningRepo struct {
	projects      []sqlc.Project
	processes     []sqlc.ListProcessesRow
	taskProcesses []sqlc.ListProcessesByTaskScopeRow
	resources     []sqlc.Resource
	milestones    []sqlc.Milestone
	tasks         []sqlc.Task
	assignments   []sqlc.Assignment
	commentCounts map[int64]int64
	dependencies  []sqlc.TaskDependency

	byIDsCalls         int
	lastProjectIDs     []int64
	lastProjectUser    int64
	lastProjectScope   rbac.ListScope
	lastProcessUser    int64
	lastProcessScope   rbac.ListScope
	lastResourceUser   int64
	lastResourceScope  rbac.ListScope
	listResourcesCalls int
}

// filterProjects mirrors ListProjectsByIDs: only rows whose id was requested
// survive; a real view zone ('all'/'own') additionally scopes by ownership,
// an empty zone (no rule / none) keeps every requested row.
func filterProjects(all []sqlc.Project, ids []int64, userID int64, scope rbac.ListScope) []sqlc.Project {
	out := make([]sqlc.Project, 0, len(all))
	for _, p := range all {
		if !slices.Contains(ids, p.ID) {
			continue
		}
		if scope.Self && (!p.OwnerID.Valid || p.OwnerID.Int64 != userID) {
			continue
		}
		out = append(out, p)
	}
	return out
}

// filterResources mirrors ListResources: 'own' keeps only the caller's rows,
// 'all' and the empty zone (no rule / none) keep every row.
func filterResources(all []sqlc.Resource, userID int64, scope rbac.ListScope) []sqlc.Resource {
	out := make([]sqlc.Resource, 0, len(all))
	for _, r := range all {
		if scope.Self && r.OwnerID != userID {
			continue
		}
		out = append(out, r)
	}
	return out
}

func (s *stubPlanningRepo) ListProjects(_ context.Context, _ int64, _ rbac.ListScope) ([]sqlc.Project, error) {
	return s.projects, nil
}

func (s *stubPlanningRepo) ListProjectsByIDs(
	_ context.Context,
	ids []int64,
	userID int64,
	scope rbac.ListScope,
) ([]sqlc.Project, error) {
	s.byIDsCalls++
	s.lastProjectIDs = ids
	s.lastProjectUser = userID
	s.lastProjectScope = scope
	if len(ids) == 0 {
		return nil, nil
	}
	return filterProjects(s.projects, ids, userID, scope), nil
}

func (s *stubPlanningRepo) ListProcesses(
	_ context.Context,
	userID int64,
	scope rbac.ListScope,
) ([]sqlc.ListProcessesRow, error) {
	s.lastProcessUser = userID
	s.lastProcessScope = scope
	return s.processes, nil
}

func (s *stubPlanningRepo) ListProcessesByTaskScope(
	_ context.Context,
	userID int64,
	scope rbac.ListScope,
) ([]sqlc.ListProcessesByTaskScopeRow, error) {
	s.lastProcessUser = userID
	s.lastProcessScope = scope
	return s.taskProcesses, nil
}

func (s *stubPlanningRepo) ListResources(
	_ context.Context,
	userID int64,
	scope rbac.ListScope,
) ([]sqlc.Resource, error) {
	s.listResourcesCalls++
	s.lastResourceUser = userID
	s.lastResourceScope = scope
	return filterResources(s.resources, userID, scope), nil
}

func (s *stubPlanningRepo) ListMilestonesByProcessIDs(_ context.Context, _ []int64) ([]sqlc.Milestone, error) {
	return s.milestones, nil
}

func (s *stubPlanningRepo) ListTasksByProcessIDs(
	_ context.Context,
	_ []int64,
	userID int64,
	scope rbac.ListScope,
) ([]sqlc.Task, error) {
	if scope.Self && !scope.All {
		rows := make([]sqlc.Task, 0, len(s.tasks))
		for _, task := range s.tasks {
			if task.OwnerID.Valid && task.OwnerID.Int64 == userID {
				rows = append(rows, task)
			}
		}
		return rows, nil
	}
	return s.tasks, nil
}

func (s *stubPlanningRepo) ListAssignmentsByTaskIDs(_ context.Context, _ []int64) ([]sqlc.Assignment, error) {
	return s.assignments, nil
}

func (s *stubPlanningRepo) ListTaskCommentCountsByTaskIDs(_ context.Context, _ []int64) (map[int64]int64, error) {
	return s.commentCounts, nil
}

func (s *stubPlanningRepo) ListTaskDependenciesByProcessIDs(
	_ context.Context,
	_ []int64,
) ([]sqlc.ListTaskDependenciesByProcessIDsRow, error) {
	out := make([]sqlc.ListTaskDependenciesByProcessIDsRow, 0, len(s.dependencies))
	for i := range s.dependencies {
		out = append(out, sqlc.ListTaskDependenciesByProcessIDsRow{TaskDependency: s.dependencies[i]})
	}
	return out, nil
}

// newPlanningTestService builds a PlanningService over the stub repository.
func newPlanningTestService(repo *stubPlanningRepo) *PlanningService {
	return &PlanningService{
		logger:     slog.New(slog.DiscardHandler),
		tracer:     tracing.New(nil),
		repository: repo,
	}
}

// projectRow builds a project row (only the fields the aggregate reads).
func projectRow(id, ownerID int64, code string) sqlc.Project {
	return sqlc.Project{
		ID:      id,
		OwnerID: pgtype.Int8{Int64: ownerID, Valid: true},
		Code:    code,
	}
}

// processRow builds a process row with its parent project context.
func processRow(id, projectID, ownerID int64, code string) sqlc.ListProcessesRow {
	return sqlc.ListProcessesRow{
		Process: sqlc.Process{
			ID:        id,
			ProjectID: projectID,
			OwnerID:   pgtype.Int8{Int64: ownerID, Valid: true},
		},
		ProjectCode: code,
	}
}

// sameIDs reports whether two id slices contain the same elements regardless
// of order (the service groups processes by id from a map).
func sameIDs(a, b []int64) bool {
	if len(a) != len(b) {
		return false
	}
	seen := make(map[int64]bool, len(a))
	for _, v := range a {
		seen[v] = true
	}
	for _, v := range b {
		if !seen[v] {
			return false
		}
	}
	return true
}

// findDetailedProject returns the detailed project with the id, nil if absent.
func findDetailedProject(t *testing.T, projects []dto.DetailedProject, id int64) *dto.DetailedProject {
	t.Helper()
	for i := range projects {
		if projects[i].ID == id {
			return &projects[i]
		}
	}
	return nil
}

// TestGetProcessPlanningScopeAll checks that with an 'all' project scope every
// process is grouped under its parent project and the scoping parameters reach
// the repository.
func TestGetProcessPlanningScopeAll(t *testing.T) {
	t.Parallel()
	repo := &stubPlanningRepo{
		projects: []sqlc.Project{
			projectRow(1, 7, "P1"),
			projectRow(2, 9, "P2"),
		},
		processes: []sqlc.ListProcessesRow{
			processRow(11, 1, 7, "P1"),
			processRow(21, 2, 9, "P2"),
		},
	}
	svc := newPlanningTestService(repo)

	got, err := svc.GetProcessPlanning(context.Background(), 7, lsAll(), lsAll())
	if err != nil {
		t.Fatalf("GetProcessPlanning() error = %v", err)
	}
	ids := make([]int64, len(got.Projects))
	for i, p := range got.Projects {
		ids[i] = p.ID
	}
	if !sameIDs(ids, []int64{1, 2}) {
		t.Errorf("project ids = %v, want {1, 2}", ids)
	}
	if p1 := findDetailedProject(t, got.Projects, 1); p1 == nil || len(p1.Processes) != 1 || p1.Processes[0].ID != 11 {
		t.Errorf("project 1 group = %+v, want process 11", findDetailedProject(t, got.Projects, 1))
	}
	if p2 := findDetailedProject(t, got.Projects, 2); p2 == nil || len(p2.Processes) != 1 || p2.Processes[0].ID != 21 {
		t.Errorf("project 2 group = %+v, want process 21", findDetailedProject(t, got.Projects, 2))
	}
	// The caller's scopes reached the repository unchanged.
	if !repo.lastProcessScope.All || repo.lastProcessUser != 7 {
		t.Errorf("process scope call = (%v, %d), want (\"all\", 7)",
			repo.lastProcessScope, repo.lastProcessUser)
	}
	if !repo.lastProjectScope.All || repo.lastProjectUser != 7 {
		t.Errorf("project scope call = (%v, %d), want (\"all\", 7)",
			repo.lastProjectScope, repo.lastProjectUser)
	}
	if !sameIDs(repo.lastProjectIDs, []int64{1, 2}) {
		t.Errorf("ListProjectsByIDs ids = %v, want {1, 2}", repo.lastProjectIDs)
	}
}

// TestGetProcessPlanningNoProjectRule checks the regression contract: a
// caller with process.view=all but NO project view rule (empty zone — e.g.
// vp) still gets every scoped process grouped under its parent project. The
// reference query must fall back to include-all instead of dropping the
// parents (which would hide all processes).
func TestGetProcessPlanningNoProjectRule(t *testing.T) {
	t.Parallel()
	repo := &stubPlanningRepo{
		projects: []sqlc.Project{
			projectRow(1, 7, "P1"),
			projectRow(2, 9, "P2"),
		},
		processes: []sqlc.ListProcessesRow{
			processRow(11, 1, 7, "P1"),
			processRow(21, 2, 9, "P2"),
		},
	}
	svc := newPlanningTestService(repo)

	got, err := svc.GetProcessPlanning(context.Background(), 7, lsAll(), lsNone())
	if err != nil {
		t.Fatalf("GetProcessPlanning() error = %v", err)
	}
	if len(got.Projects) != 2 {
		t.Fatalf("aggregate = %+v, want both parent projects (empty project zone = include-all)", got.Projects)
	}
	if p1 := findDetailedProject(t, got.Projects, 1); p1 == nil || len(p1.Processes) != 1 || p1.Processes[0].ID != 11 {
		t.Errorf("project 1 group = %+v, want process 11", findDetailedProject(t, got.Projects, 1))
	}
	if p2 := findDetailedProject(t, got.Projects, 2); p2 == nil || len(p2.Processes) != 1 || p2.Processes[0].ID != 21 {
		t.Errorf("project 2 group = %+v, want process 21", findDetailedProject(t, got.Projects, 2))
	}
	// The empty reference zone reaches the repository unchanged.
	if !repo.lastProjectScope.None {
		t.Errorf("project scope call = %v, want none (no project view rule)", repo.lastProjectScope)
	}
}

// TestGetProcessPlanningScopeOwnDropsForeignProcesses checks that with an
// 'own' project scope processes of projects outside the caller's ownership are
// dropped from the aggregate (the parent project is not visible).
func TestGetProcessPlanningScopeOwnDropsForeignProcesses(t *testing.T) {
	t.Parallel()
	repo := &stubPlanningRepo{
		projects: []sqlc.Project{
			projectRow(1, 7, "P1"),
			projectRow(2, 9, "P2"),
		},
		processes: []sqlc.ListProcessesRow{
			processRow(11, 1, 7, "P1"),
			processRow(21, 2, 9, "P2"),
		},
	}
	svc := newPlanningTestService(repo)

	got, err := svc.GetProcessPlanning(context.Background(), 7, lsAll(), lsOwn())
	if err != nil {
		t.Fatalf("GetProcessPlanning() error = %v", err)
	}
	if len(got.Projects) != 1 || got.Projects[0].ID != 1 {
		t.Fatalf("aggregate = %+v, want only the owned project 1", got.Projects)
	}
	// The foreign process was dropped together with its hidden parent.
	if len(got.Projects[0].Processes) != 1 || got.Projects[0].Processes[0].ID != 11 {
		t.Errorf("owned group processes = %+v, want process 11", got.Projects[0].Processes)
	}
	if !repo.lastProjectScope.Self {
		t.Errorf("project scope call = %v, want self", repo.lastProjectScope)
	}
}

// TestGetProcessPlanningEmptyIDs checks that no processes yields an empty,
// non-nil aggregate and a single repository call with an empty id list.
func TestGetProcessPlanningEmptyIDs(t *testing.T) {
	t.Parallel()
	repo := &stubPlanningRepo{projects: []sqlc.Project{projectRow(1, 7, "P1")}}
	svc := newPlanningTestService(repo)

	got, err := svc.GetProcessPlanning(context.Background(), 7, lsAll(), lsOwn())
	if err != nil {
		t.Fatalf("GetProcessPlanning() error = %v", err)
	}
	if got == nil || got.Projects == nil || len(got.Projects) != 0 {
		t.Fatalf("aggregate = %+v, want a non-nil empty project list", got)
	}
	if repo.byIDsCalls != 1 {
		t.Errorf("ListProjectsByIDs calls = %d, want 1", repo.byIDsCalls)
	}
	if len(repo.lastProjectIDs) != 0 {
		t.Errorf("ListProjectsByIDs ids = %v, want empty", repo.lastProjectIDs)
	}
	if !repo.lastProjectScope.Self {
		t.Errorf("project scope call = %v, want self", repo.lastProjectScope)
	}
}

// TestGetProcessPlanningMissingProjectIDNoPanic checks that a process whose
// parent project row is missing/deleted is skipped without panicking.
func TestGetProcessPlanningMissingProjectIDNoPanic(t *testing.T) {
	t.Parallel()
	repo := &stubPlanningRepo{
		projects: []sqlc.Project{projectRow(1, 7, "P1")},
		processes: []sqlc.ListProcessesRow{
			processRow(11, 1, 7, "P1"),
			processRow(21, 2, 9, "P2"),
		},
	}
	svc := newPlanningTestService(repo)

	got, err := svc.GetProcessPlanning(context.Background(), 7, lsAll(), lsAll())
	if err != nil {
		t.Fatalf("GetProcessPlanning() error = %v", err)
	}
	if len(got.Projects) != 1 || got.Projects[0].ID != 1 {
		t.Fatalf("aggregate = %+v, want only project 1 (project 2 is missing)", got.Projects)
	}
	if repo.byIDsCalls != 1 {
		t.Errorf("ListProjectsByIDs calls = %d, want 1", repo.byIDsCalls)
	}
}

// taskScopeProcessRow builds a task-scope process row.
func taskScopeProcessRow(id, projectID int64) sqlc.ListProcessesByTaskScopeRow {
	return sqlc.ListProcessesByTaskScopeRow{
		Process: sqlc.Process{ID: id, ProjectID: projectID},
	}
}

// taskRow builds a task row of a process.
func taskRow(id, processID int64) sqlc.Task {
	return sqlc.Task{ID: id, ProcessID: processID}
}

// TestGetTaskPlanningResourceScopeOwn checks that an 'own' resource zone
// filters foreign resources out: assignments to those resources are dropped
// from the task, the owned resource stays with its quantity and assignment id.
func TestGetTaskPlanningResourceScopeOwn(t *testing.T) {
	t.Parallel()
	repo := &stubPlanningRepo{
		taskProcesses: []sqlc.ListProcessesByTaskScopeRow{taskScopeProcessRow(1, 1)},
		tasks:         []sqlc.Task{taskRow(10, 1)},
		assignments: []sqlc.Assignment{
			{ID: 100, TaskID: 10, ResourceID: 20, Quantity: 3},
			{ID: 101, TaskID: 10, ResourceID: 30, Quantity: 5},
		},
		resources: []sqlc.Resource{
			{ID: 20, OwnerID: 7, Title: "Mounter", Code: "M"},
			{ID: 30, OwnerID: 9, Title: "Engineer", Code: "E"},
		},
	}
	svc := newPlanningTestService(repo)

	got, err := svc.GetTaskPlanning(context.Background(), 7, lsAll(), lsOwn())
	if err != nil {
		t.Fatalf("GetTaskPlanning() error = %v", err)
	}
	if len(got.Processes) != 1 || len(got.Processes[0].Tasks) != 1 {
		t.Fatalf("processes = %+v, want process 1 with task 10", got.Processes)
	}
	task := got.Processes[0].Tasks[0]
	if len(task.Resources) != 1 {
		t.Fatalf("task resources = %+v, want only the owned resource 20", task.Resources)
	}
	res := task.Resources[0]
	if res.ID != 20 || res.Quantity != 3 || res.AssignmentID != 100 {
		t.Errorf("task resource = %+v, want resource 20 with quantity 3 and assignment 100", res)
	}
	if repo.lastResourceUser != 7 || !repo.lastResourceScope.Self {
		t.Errorf("resource scope call = (%d, %v), want (7, self)",
			repo.lastResourceUser, repo.lastResourceScope)
	}
}

// TestGetTaskPlanningNoResourceRule checks the reference fallback for
// resources: a caller with a task view but NO resource view rule (empty zone,
// e.g. dp) keeps every resource assigned to its visible tasks instead of
// losing them all. The rows are built inline (not via the taskScopeProcessRow
// / taskRow helpers) so the helper call sites keep their existing pattern.
func TestGetTaskPlanningNoResourceRule(t *testing.T) {
	t.Parallel()
	repo := &stubPlanningRepo{
		taskProcesses: []sqlc.ListProcessesByTaskScopeRow{
			{Process: sqlc.Process{ID: 1, ProjectID: 1}},
		},
		tasks: []sqlc.Task{{ID: 10, ProcessID: 1}},
		assignments: []sqlc.Assignment{
			{ID: 100, TaskID: 10, ResourceID: 20, Quantity: 3},
			{ID: 101, TaskID: 10, ResourceID: 30, Quantity: 5},
		},
		resources: []sqlc.Resource{
			{ID: 20, OwnerID: 7, Title: "Mounter", Code: "M"},
			{ID: 30, OwnerID: 9, Title: "Engineer", Code: "E"},
		},
	}
	svc := newPlanningTestService(repo)

	got, err := svc.GetTaskPlanning(context.Background(), 7, lsAll(), lsNone())
	if err != nil {
		t.Fatalf("GetTaskPlanning() error = %v", err)
	}
	if len(got.Processes) != 1 || len(got.Processes[0].Tasks) != 1 {
		t.Fatalf("processes = %+v, want process 1 with task 10", got.Processes)
	}
	resources := got.Processes[0].Tasks[0].Resources
	if len(resources) != 2 {
		t.Fatalf("task resources = %+v, want both resources (empty resource zone = include-all)", resources)
	}
	ids := []int64{resources[0].ID, resources[1].ID}
	if !sameIDs(ids, []int64{20, 30}) {
		t.Errorf("task resource ids = %v, want {20, 30}", ids)
	}
	// The empty reference zone reaches the repository unchanged.
	if !repo.lastResourceScope.None {
		t.Errorf("resource scope call = %v, want none (no resource view rule)", repo.lastResourceScope)
	}
}

// TestGetTaskPlanningResourceScopeAll checks that an 'all' resource zone keeps
// every resource assigned to the task.
func TestGetTaskPlanningResourceScopeAll(t *testing.T) {
	t.Parallel()
	repo := &stubPlanningRepo{
		taskProcesses: []sqlc.ListProcessesByTaskScopeRow{taskScopeProcessRow(1, 1)},
		tasks:         []sqlc.Task{taskRow(10, 1)},
		assignments: []sqlc.Assignment{
			{ID: 100, TaskID: 10, ResourceID: 20, Quantity: 3},
			{ID: 101, TaskID: 10, ResourceID: 30, Quantity: 5},
		},
		resources: []sqlc.Resource{
			{ID: 20, OwnerID: 7, Title: "Mounter", Code: "M"},
			{ID: 30, OwnerID: 9, Title: "Engineer", Code: "E"},
		},
	}
	svc := newPlanningTestService(repo)

	got, err := svc.GetTaskPlanning(context.Background(), 7, lsAll(), lsAll())
	if err != nil {
		t.Fatalf("GetTaskPlanning() error = %v", err)
	}
	if len(got.Processes) != 1 || len(got.Processes[0].Tasks) != 1 {
		t.Fatalf("processes = %+v, want process 1 with task 10", got.Processes)
	}
	resources := got.Processes[0].Tasks[0].Resources
	if len(resources) != 2 {
		t.Fatalf("task resources = %+v, want both resources", resources)
	}
	ids := []int64{resources[0].ID, resources[1].ID}
	if !sameIDs(ids, []int64{20, 30}) {
		t.Errorf("task resource ids = %v, want {20, 30}", ids)
	}
	if !repo.lastResourceScope.All {
		t.Errorf("resource scope call = %v, want all", repo.lastResourceScope)
	}
}

// TestGetTaskPlanningEmptyResources checks that an empty resource set keeps
// the aggregate consistent: empty non-nil arrays, no nil maps leaking.
func TestGetTaskPlanningEmptyResources(t *testing.T) {
	t.Parallel()
	repo := &stubPlanningRepo{
		taskProcesses: []sqlc.ListProcessesByTaskScopeRow{taskScopeProcessRow(1, 1)},
		tasks:         []sqlc.Task{taskRow(10, 1)},
		assignments: []sqlc.Assignment{
			{ID: 100, TaskID: 10, ResourceID: 20, Quantity: 3},
		},
	}
	svc := newPlanningTestService(repo)

	got, err := svc.GetTaskPlanning(context.Background(), 7, lsAll(), lsOwn())
	if err != nil {
		t.Fatalf("GetTaskPlanning() error = %v", err)
	}
	if len(got.Processes) != 1 {
		t.Fatalf("processes = %+v, want process 1", got.Processes)
	}
	task := got.Processes[0].Tasks[0]
	if task.Resources == nil || len(task.Resources) != 0 {
		t.Errorf("task resources = %v, want a non-nil empty slice", task.Resources)
	}
	if got.Processes[0].Milestones == nil || len(got.Processes[0].Milestones) != 0 {
		t.Errorf("milestones = %v, want a non-nil empty slice", got.Processes[0].Milestones)
	}
	if !repo.lastResourceScope.Self {
		t.Errorf("resource scope call = %v, want own", repo.lastResourceScope)
	}
}

// TestGetTaskPlanningNoProcesses checks that an empty process set short-
// circuits before loading any reference data (no resource call at all).
func TestGetTaskPlanningNoProcesses(t *testing.T) {
	t.Parallel()
	repo := &stubPlanningRepo{resources: []sqlc.Resource{{ID: 20, OwnerID: 7}}}
	svc := newPlanningTestService(repo)

	got, err := svc.GetTaskPlanning(context.Background(), 7, lsAll(), lsOwn())
	if err != nil {
		t.Fatalf("GetTaskPlanning() error = %v", err)
	}
	if got == nil || got.Processes == nil || len(got.Processes) != 0 {
		t.Fatalf("processes = %+v, want a non-nil empty list", got)
	}
	if repo.listResourcesCalls != 0 {
		t.Errorf("ListResources calls = %d, want 0 (no processes to load data for)",
			repo.listResourcesCalls)
	}
}

// TestGetTaskPlanningDependencies checks that the scheduling links of a
// process are embedded into the DetailedProcess aggregate (for the diagram
// arrows and the editor).
func TestGetTaskPlanningDependencies(t *testing.T) {
	t.Parallel()
	repo := &stubPlanningRepo{
		taskProcesses: []sqlc.ListProcessesByTaskScopeRow{
			{Process: sqlc.Process{ID: 1, ProjectID: 1}},
		},
		tasks: []sqlc.Task{
			{ID: 10, ProcessID: 1},
			{ID: 11, ProcessID: 1},
		},
		dependencies: []sqlc.TaskDependency{
			{ID: 1, TaskID: 11, DependsOnTaskID: 10, Type: "fs"},
		},
	}
	svc := newPlanningTestService(repo)

	got, err := svc.GetTaskPlanning(context.Background(), 7, lsAll(), lsOwn())
	if err != nil {
		t.Fatalf("GetTaskPlanning() error = %v", err)
	}
	if len(got.Processes) != 1 {
		t.Fatalf("processes = %+v, want process 1", got.Processes)
	}
	deps := got.Processes[0].Dependencies
	if len(deps) != 1 {
		t.Fatalf("dependencies = %+v, want one link", deps)
	}
	dep := deps[0]
	if dep.TaskID != 11 || dep.DependsOnTaskID != 10 || dep.Type != "fs" {
		t.Errorf("dependency = %+v, want 11->10 type fs", dep)
	}
}
