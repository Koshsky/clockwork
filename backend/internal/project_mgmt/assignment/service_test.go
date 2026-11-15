package assignment_test

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"reflect"
	"testing"

	access "github.com/Koshsky/erp-backend/internal/authz/domain"
	assignment "github.com/Koshsky/erp-backend/internal/project_mgmt/assignment"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/assignment/dto"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/assignment/repository/sqlc"
	"github.com/Koshsky/erp-backend/internal/tracing"
	errorsapi "github.com/Koshsky/erp-backend/pkg/errors"
)

type assignmentRepository struct {
	row                                   *sqlc.Assignment
	rows                                  []sqlc.Assignment
	foundErr, writeErr, listErr, countErr error
	reads, writes, counts                 int
	quantity                              int
	user, owner                           int64
	scope                                 access.ListScope
	limit, offset                         int
}

func assignmentFixture() sqlc.Assignment {
	return sqlc.Assignment{ID: 3, TaskID: 11, ResourceID: 21, Quantity: 2}
}

func newService(repo *assignmentRepository) *assignment.Service {
	return assignment.NewService(slog.New(slog.DiscardHandler), tracing.New(nil), repo)
}

func (r *assignmentRepository) CreateAssignment(
	_ context.Context,
	task, resource int64,
	quantity int,
) (*sqlc.Assignment, error) {
	r.writes++
	r.row = &sqlc.Assignment{ID: 3, TaskID: task, ResourceID: resource, Quantity: int32(quantity)}
	return r.row, r.writeErr
}

func (r *assignmentRepository) FindAssignment(context.Context, int64) (*sqlc.Assignment, error) {
	r.reads++
	if r.row == nil {
		return nil, r.foundErr
	}
	row := *r.row
	return &row, r.foundErr
}

func (r *assignmentRepository) UpdateAssignment(
	_ context.Context,
	row sqlc.Assignment,
	quantity int,
) (*sqlc.Assignment, error) {
	r.writes++
	r.quantity = quantity
	row.Quantity = int32(quantity)
	r.row = &row
	return r.row, r.writeErr
}

func (r *assignmentRepository) DeleteAssignment(context.Context, int64) error {
	r.writes++
	return r.writeErr
}

func (r *assignmentRepository) ListAssignments(
	_ context.Context,
	user int64,
	scope access.ListScope,
	owner int64,
	limit, offset int,
) ([]sqlc.Assignment, error) {
	r.user, r.scope, r.owner, r.limit, r.offset = user, scope, owner, limit, offset
	return r.rows, r.listErr
}

func (r *assignmentRepository) CountAssignments(
	_ context.Context,
	user int64,
	scope access.ListScope,
	owner int64,
) (int64, error) {
	r.counts++
	if user != r.user || owner != r.owner || !reflect.DeepEqual(scope, r.scope) {
		return 0, errors.New("list/count filter mismatch")
	}
	return 19, r.countErr
}

func TestAssignmentCRUD(t *testing.T) {
	t.Parallel()
	for _, quantity := range []int{1, 7} {
		repo := &assignmentRepository{}
		svc := newService(repo)
		created, err := svc.CreateAssignment(
			t.Context(),
			dto.CreateAssignmentRequest{TaskID: 11, ResourceID: 21, Quantity: quantity},
		)
		want := dto.AssignmentResponse{ID: 3, TaskID: 11, ResourceID: 21, Quantity: quantity}
		if err != nil || !reflect.DeepEqual(created, &want) || repo.writes != 1 {
			t.Fatalf("create changed fields: %+v, %v", created, err)
		}
		found, err := svc.FindAssignment(t.Context(), 3)
		if err != nil || !reflect.DeepEqual(found, created) {
			t.Fatalf("find changed fields: %+v, %v", found, err)
		}
		if err = svc.DeleteAssignment(t.Context(), 3); err != nil || repo.writes != 2 {
			t.Fatalf("delete did not reach repository: %v", err)
		}
	}
}

func TestAssignmentValidationBeforeWrite(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name           string
		task, resource int64
		quantity       int
	}{
		{"zero task", 0, 21, 1}, {"negative task", -1, 21, 1}, {"zero resource", 11, 0, 1}, {"negative resource", 11, -1, 1},
		{"zero quantity", 11, 21, 0}, {"negative quantity", 11, 21, -1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			repo := &assignmentRepository{}
			response, err := newService(
				repo,
			).CreateAssignment(t.Context(), dto.CreateAssignmentRequest{TaskID: tc.task, ResourceID: tc.resource, Quantity: tc.quantity})
			if !errors.Is(err, errorsapi.ErrValidation) || response != nil || repo.reads != 0 || repo.writes != 0 {
				t.Fatalf("invalid create reached repository: %+v, %v", repo, err)
			}
		})
	}
}

func TestAssignmentPatchSemantics(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, body     string
		task, resource int64
		quantity       int
		invalid        bool
	}{
		{"absent", `{}`, 11, 21, 2, false},
		{"null", `{"task_id":null,"resource_id":null,"quantity":null}`, 11, 21, 2, false},
		{"quantity", `{"quantity":7}`, 11, 21, 7, false},
		{"replace", `{"task_id":12,"resource_id":22,"quantity":4}`, 12, 22, 4, false},
		{"zero quantity", `{"quantity":0}`, 0, 0, 0, true},
		{"zero resource", `{"resource_id":0}`, 0, 0, 0, true},
		{"zero task", `{"task_id":0}`, 0, 0, 0, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			row := assignmentFixture()
			repo := &assignmentRepository{row: &row}
			var req dto.UpdateAssignmentRequest
			if err := json.Unmarshal([]byte(tc.body), &req); err != nil {
				t.Fatal(err)
			}
			response, err := newService(repo).UpdateAssignment(t.Context(), 3, req)
			if tc.invalid {
				if !errors.Is(err, errorsapi.ErrValidation) || repo.writes != 0 || *repo.row != row {
					t.Fatalf("invalid patch changed stored row: %v", err)
				}
				return
			}
			want := dto.AssignmentResponse{ID: 3, TaskID: tc.task, ResourceID: tc.resource, Quantity: tc.quantity}
			if err != nil || !reflect.DeepEqual(response, &want) || repo.quantity != tc.quantity || repo.writes != 1 {
				t.Fatalf("patch semantics changed: %+v, %v", response, err)
			}
		})
	}
}

func TestAssignmentMappingAndListScope(t *testing.T) {
	t.Parallel()
	mapper := assignment.NewMapper()
	if mapper.ToDTO(nil) != nil || mapper.ToDTOs(nil) == nil || len(mapper.ToDTOs(nil)) != 0 {
		t.Fatal("nil/empty mapping changed")
	}
	for _, scope := range []access.ListScope{{All: true}, {Parent: true}, {ProjectOwner: true}, {TaskView: []string{"self"}}} {
		repo := &assignmentRepository{rows: []sqlc.Assignment{assignmentFixture(), {ID: 1, Quantity: 9}}}
		items, total, err := newService(repo).ListAssignments(t.Context(), 7, scope, 8, 20, 40)
		if err != nil || total != 19 || len(items) != 2 || items[0].ID != 3 || items[1].ID != 1 ||
			items[1].Quantity != 9 ||
			repo.counts != 1 ||
			repo.user != 7 ||
			repo.owner != 8 ||
			repo.limit != 20 ||
			repo.offset != 40 ||
			!reflect.DeepEqual(repo.scope, scope) {
			t.Fatalf("list/mapping changed: %+v, %d, %v", repo, total, err)
		}
	}
}

func TestAssignmentReadDeleteFailures(t *testing.T) {
	t.Parallel()
	failure := errors.New("database unavailable")
	for _, tc := range []struct {
		name    string
		row     *sqlc.Assignment
		failure error
	}{
		{"missing", nil, errorsapi.ErrNotFound}, {"nil", nil, nil}, {"database", nil, failure},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			repo := &assignmentRepository{row: tc.row, foundErr: tc.failure}
			svc := newService(repo)
			_, err := svc.FindAssignment(t.Context(), 3)
			want := errorsapi.ErrAssignmentNotFound
			if errors.Is(tc.failure, failure) {
				want = failure
			}
			if !errors.Is(err, want) {
				t.Fatalf("find error changed: %v", err)
			}
			if _, err = svc.UpdateAssignment(
				t.Context(),
				3,
				dto.UpdateAssignmentRequest{},
			); !errors.Is(
				err,
				errorsapi.ErrAssignmentNotFound,
			) {
				t.Fatalf("update fetch classification changed: %v", err)
			}
			err = svc.DeleteAssignment(t.Context(), 3)
			want = nil
			if errors.Is(tc.failure, failure) {
				want = failure
			}
			if !errors.Is(err, want) || repo.writes != 0 {
				t.Fatalf("delete error/idempotency changed: %v", err)
			}
		})
	}
}

func TestAssignmentWriteAndListFailures(t *testing.T) {
	t.Parallel()
	failure := errors.New("database unavailable")
	repo := &assignmentRepository{row: new(assignmentFixture()), writeErr: failure}
	svc := newService(repo)
	if _, err := svc.CreateAssignment(
		t.Context(),
		dto.CreateAssignmentRequest{TaskID: 11, ResourceID: 21, Quantity: 1},
	); !errors.Is(
		err,
		failure,
	) {
		t.Fatalf("create error swallowed: %v", err)
	}
	if _, err := svc.UpdateAssignment(t.Context(), 3, dto.UpdateAssignmentRequest{}); !errors.Is(err, failure) {
		t.Fatalf("update error swallowed: %v", err)
	}
	if err := svc.DeleteAssignment(t.Context(), 3); !errors.Is(err, failure) {
		t.Fatalf("delete error swallowed: %v", err)
	}
	for _, first := range []bool{true, false} {
		listRepo := &assignmentRepository{}
		if first {
			listRepo.listErr = failure
		} else {
			listRepo.countErr = failure
		}
		items, total, err := newService(
			listRepo,
		).ListAssignments(t.Context(), 7, access.ListScope{All: true}, 0, 50, 0)
		if !errors.Is(err, failure) || items != nil || total != 0 || (first && listRepo.counts != 0) {
			t.Fatalf("list/count failure changed: %+v, %d, %v", listRepo, total, err)
		}
	}
}
