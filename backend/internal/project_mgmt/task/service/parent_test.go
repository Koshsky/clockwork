package service //nolint:testpackage // Tests private parent normalization without exposing a production API.

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/Koshsky/erp-backend/internal/project_mgmt/task/repository/sqlc"
	"github.com/Koshsky/erp-backend/pkg/errors"
)

type parentRepository struct {
	TaskRepository

	parent *sqlc.Task
}

func (r *parentRepository) FindTask(context.Context, int64) (*sqlc.Task, error) {
	return r.parent, nil
}

func TestApplyParentRejectsProcessSubstitution(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name      string
		processID int64
		wantError bool
	}{
		{"same process", 10, false},
		{"different process", 20, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			parentID := int64(1)
			service := &TaskService{repository: &parentRepository{
				parent: &sqlc.Task{ID: parentID, ProcessID: 10, StartDate: "2026-11-01", EndDate: "2026-11-30"},
			}}
			task := &sqlc.Task{ProcessID: tc.processID, OwnerID: pgtype.Int8{Int64: 7, Valid: true}}
			err := service.applyParent(t.Context(), task, &parentID)
			assertParentResult(t, task, err, tc.wantError, tc.processID)
		})
	}
}

func assertParentResult(t *testing.T, task *sqlc.Task, err error, wantError bool, processID int64) {
	t.Helper()
	if wantError {
		if err == nil || !errors.IsValidationError(err) {
			t.Fatalf("expected validation error, got %v", err)
		}
		if task.ProcessID != processID {
			t.Fatal("rejected parent changed the requested process")
		}
		return
	}
	if err != nil {
		t.Fatal(err)
	}
	if task.ProcessID != 10 || task.StartDate != "2026-11-01" || task.EndDate != "2026-11-30" {
		t.Fatal("subtask did not retain its process and inherit parent dates")
	}
	if task.OwnerID.Int64 != 7 || !task.OwnerID.Valid {
		t.Fatal("parent replaced the explicitly assigned subtask owner")
	}
}
