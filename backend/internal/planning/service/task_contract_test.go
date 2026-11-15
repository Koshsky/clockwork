//nolint:testpackage // Shares the existing planning repository fixture for aggregate contract checks.
package service

import (
	"reflect"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/Koshsky/erp-backend/internal/planning/dto"
	"github.com/Koshsky/erp-backend/internal/planning/repository/sqlc"
)

func TestTaskPlanningKeepsSubtasksStatusesAndOrder(t *testing.T) {
	t.Parallel()
	repo := &stubPlanningRepo{
		taskProcesses: []sqlc.ListProcessesByTaskScopeRow{
			{
				Process:     sqlc.Process{ID: 11, ProjectID: 31, OwnerID: pgtype.Int8{Int64: 7, Valid: true}},
				ProjectCode: "P",
			},
		},
		tasks: []sqlc.Task{
			{
				ID:        2,
				ProcessID: 11,
				ParentID:  pgtype.Int8{Int64: 1, Valid: true},
				Title:     "Operation 1",
				Status:    "in_progress",
				StartDate: "2026-12-31",
				EndDate:   "2027-01-03",
				SortOrder: 1,
			},
			{
				ID:            1,
				ProcessID:     11,
				OwnerID:       pgtype.Int8{Int64: 7, Valid: true},
				ResponsibleID: pgtype.Int8{Int64: 8, Valid: true},
				Title:         "Задача <one>",
				Status:        "not_started",
				StartDate:     "2026-12-31",
				EndDate:       "2027-01-03",
				SortOrder:     2,
			},
			{
				ID:        4,
				ProcessID: 11,
				ParentID:  pgtype.Int8{Int64: 1, Valid: true},
				Title:     "Operation 2",
				Status:    "done",
				StartDate: "2026-12-31",
				EndDate:   "2027-01-03",
				SortOrder: 3,
			},
			{
				ID:        3,
				ProcessID: 11,
				Title:     "Last task",
				Status:    "done",
				StartDate: "2027-01-04",
				EndDate:   "2027-01-05",
				SortOrder: 4,
			},
		},
		commentCounts: map[int64]int64{1: 4, 2: 2},
	}
	result, err := newPlanningTestService(repo).GetTaskPlanning(t.Context(), 7, lsAll(), lsAll())
	if err != nil || result == nil || len(result.Processes) != 1 {
		t.Fatalf("task planning failed: %+v, %v", result, err)
	}
	tasks := result.Processes[0].Tasks
	if len(tasks) != 2 || tasks[0].ID != 1 || tasks[1].ID != 3 || tasks[1].Order != 4 {
		t.Fatalf("top-level order/grouping changed: %+v", tasks)
	}
	wantParent := dto.Task{
		ID:            1,
		ProcessID:     11,
		OwnerID:       new(int64(7)),
		ResponsibleID: new(int64(8)),
		Title:         "Задача <one>",
		Status:        "not_started",
		StartDate:     "2026-12-31",
		EndDate:       "2027-01-03",
		Order:         2,
	}
	if !reflect.DeepEqual(tasks[0].Task, wantParent) || tasks[0].CommentsCount != 4 {
		t.Fatalf("task fields changed: %+v", tasks[0])
	}
	children := tasks[0].Subtasks
	if len(children) != 2 || children[0].ID != 2 || children[1].ID != 4 || children[0].Order != 1 ||
		children[1].Order != 3 {
		t.Fatalf("subtask order changed: %+v", children)
	}
	if children[0].ParentID == nil || *children[0].ParentID != 1 || children[0].Status != "in_progress" ||
		children[1].Status != "done" ||
		children[0].CommentsCount != 2 {
		t.Fatalf("subtask fields changed: %+v", children)
	}
}
