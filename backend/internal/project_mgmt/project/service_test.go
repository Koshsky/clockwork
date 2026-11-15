package project_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"reflect"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"

	access "github.com/Koshsky/erp-backend/internal/authz/domain"
	project "github.com/Koshsky/erp-backend/internal/project_mgmt/project"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/project/dto"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/project/repository/sqlc"
	"github.com/Koshsky/erp-backend/internal/tracing"
	nullable "github.com/Koshsky/erp-backend/pkg/database"
	"github.com/Koshsky/erp-backend/pkg/date"
	errorsapi "github.com/Koshsky/erp-backend/pkg/errors"
)

type projectRepository struct {
	row                                                *sqlc.Project
	rows                                               []sqlc.Project
	foundErr, writeErr, listErr, countErr, feedbackErr error
	reads, writes, counts, feedbackCalls               int
	user, owner                                        int64
	scope                                              access.ListScope
	limit, offset                                      int
}

func projectFixture() sqlc.Project {
	return sqlc.Project{ID: 3, OwnerID: pgtype.Int8{Int64: 7, Valid: true},
		ResponsibleID: pgtype.Int8{Int64: 8, Valid: true}, Code: "Проект <one>",
		Color:     sql.NullString{String: "#ab12EF", Valid: true},
		StartDate: "2026-12-31", EndDate: "2027-01-02", Priority: 2}
}

func newService(repo *projectRepository) *project.Service {
	return project.NewService(slog.New(slog.DiscardHandler), tracing.New(nil), repo)
}

func (r *projectRepository) CreateProject(_ context.Context, owner, responsible *int64, code string,
	color *string, start, end date.Date, priority int,
) (*sqlc.Project, error) {
	r.writes++
	r.row = &sqlc.Project{ID: 3, OwnerID: nullable.ToInt8(owner), ResponsibleID: nullable.ToInt8(responsible),
		Code: code, Color: nullable.ToString(color), StartDate: start, EndDate: end, Priority: int32(priority)}
	return r.row, r.writeErr
}

func (r *projectRepository) FindProject(context.Context, int64) (*sqlc.Project, error) {
	r.reads++
	if r.row == nil {
		return nil, r.foundErr
	}
	row := *r.row
	return &row, r.foundErr
}

func (r *projectRepository) UpdateProject(_ context.Context, row sqlc.Project, priority int) (*sqlc.Project, error) {
	r.writes++
	row.Priority = int32(priority)
	r.row = &row
	return &row, r.writeErr
}

func (r *projectRepository) DeleteProject(context.Context, int64) error {
	r.writes++
	return r.writeErr
}

func (r *projectRepository) ListProjects(_ context.Context, user int64, scope access.ListScope, owner int64,
	limit, offset int,
) ([]sqlc.Project, error) {
	r.user, r.scope, r.owner, r.limit, r.offset = user, scope, owner, limit, offset
	return r.rows, r.listErr
}

func (r *projectRepository) CountProjects(
	_ context.Context,
	user int64,
	scope access.ListScope,
	owner int64,
) (int64, error) {
	r.counts++
	if user != r.user || owner != r.owner || !reflect.DeepEqual(scope, r.scope) {
		return 0, errors.New("list/count scope mismatch")
	}
	return 17, r.countErr
}

func (r *projectRepository) AutoCreatedCounts(_ context.Context, id int64) (sqlc.CountAutoCreatedEntitiesRow, error) {
	r.feedbackCalls++
	if id != 3 {
		return sqlc.CountAutoCreatedEntitiesRow{}, errors.New("feedback for wrong project")
	}
	if r.feedbackErr != nil {
		return sqlc.CountAutoCreatedEntitiesRow{}, r.feedbackErr
	}
	return sqlc.CountAutoCreatedEntitiesRow{Processes: 2, Tasks: 4, Assignments: 6}, nil
}

func TestProjectCreateOwnershipAndFeedback(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name                                string
		force, missingOwner, failedFeedback bool
	}{
		{"explicit owner", false, false, false}, {"force owner", true, false, false},
		{"forced missing owner", true, true, false}, {"nullable owner", false, true, false},
		{"feedback unavailable", true, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			row := projectFixture()
			request := dto.CreateProjectRequest{
				OwnerID:       nullable.Int64Ptr(row.OwnerID),
				ResponsibleID: nullable.Int64Ptr(row.ResponsibleID),
				Code:          row.Code,
				Color:         nullable.StringPtr(row.Color),
				StartDate:     row.StartDate,
				EndDate:       row.EndDate,
				Priority:      0,
			}
			if tc.missingOwner {
				request.OwnerID = nil
			}
			repo := &projectRepository{}
			if tc.failedFeedback {
				repo.feedbackErr = errors.New("feedback unavailable")
			}
			response, err := newService(repo).CreateProject(t.Context(), request, 9, tc.force)
			wantOwner := request.OwnerID
			if tc.force {
				wantOwner = new(int64(9))
			}
			counts := dto.AutoCreatedCounts{Processes: 2, Tasks: 4, Assignments: 6}
			if tc.failedFeedback {
				counts = dto.AutoCreatedCounts{}
			}
			want := dto.CreateProjectResponse{
				ID:            3,
				OwnerID:       wantOwner,
				ResponsibleID: request.ResponsibleID,
				Code:          row.Code,
				Color:         request.Color,
				StartDate:     row.StartDate,
				EndDate:       row.EndDate,
				Priority:      0,
				AutoCreated:   counts,
			}
			if err != nil || !reflect.DeepEqual(response, &want) || repo.writes != 1 || repo.feedbackCalls != 1 {
				t.Fatalf("create/feedback changed: %+v, %v", response, err)
			}
		})
	}
}

func TestProjectPatchSemantics(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, body string
		change     func(*sqlc.Project)
	}{
		{"absent", `{}`, func(*sqlc.Project) {}},
		{"null", `{"owner_id":null,"responsible_id":null,"color":null,"priority":null,"start_date":null}`, func(*sqlc.Project) {}},
		{"clear responsible", `{"responsible_id":0}`, func(p *sqlc.Project) { p.ResponsibleID = pgtype.Int8{} }},
		{"clear color", `{"color":""}`, func(p *sqlc.Project) { p.Color = sql.NullString{} }},
		{"zero priority", `{"priority":0}`, func(p *sqlc.Project) { p.Priority = 0 }},
		{"replace", `{"owner_id":9,"responsible_id":10,"code":"Новый <P>","color":"#123456","priority":7,"start_date":"2027-01-01","end_date":"2027-01-05"}`, func(p *sqlc.Project) {
			p.OwnerID = pgtype.Int8{Int64: 9, Valid: true}
			p.ResponsibleID = pgtype.Int8{Int64: 10, Valid: true}
			p.Code = "Новый <P>"
			p.Color = sql.NullString{String: "#123456", Valid: true}
			p.Priority = 7
			p.StartDate = "2027-01-01"
			p.EndDate = "2027-01-05"
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			row := projectFixture()
			want := row
			tc.change(&want)
			repo := &projectRepository{row: &row}
			var request dto.UpdateProjectRequest
			if err := json.Unmarshal([]byte(tc.body), &request); err != nil {
				t.Fatal(err)
			}
			response, err := newService(repo).UpdateProject(t.Context(), 3, request)
			if err != nil || !reflect.DeepEqual(response, project.NewMapper().ToDTO(&want)) || *repo.row != want ||
				repo.writes != 1 {
				t.Fatalf("patch changed fields: %+v, %v", response, err)
			}
		})
	}
}

func TestProjectValidationBeforeWrite(t *testing.T) {
	t.Parallel()
	for _, body := range []string{`{"code":" "}`, `{"color":"red"}`, `{"priority":-1}`, `{"start_date":""}`, `{"end_date":""}`, `{"end_date":"2026-12-30"}`} {
		t.Run(body, func(t *testing.T) {
			t.Parallel()
			row := projectFixture()
			repo := &projectRepository{row: &row}
			svc := newService(repo)
			var patch dto.UpdateProjectRequest
			if err := json.Unmarshal([]byte(body), &patch); err != nil {
				t.Fatal(err)
			}
			if response, err := svc.UpdateProject(
				t.Context(),
				3,
				patch,
			); !errors.Is(err, errorsapi.ErrValidation) || response != nil || repo.writes != 0 ||
				*repo.row != row {
				t.Fatalf("invalid update reached write: %v", err)
			}
			request := dto.CreateProjectRequest{
				Code:      row.Code,
				StartDate: row.StartDate,
				EndDate:   row.EndDate,
				Priority:  2,
			}
			if err := json.Unmarshal([]byte(body), &request); err != nil {
				t.Fatal(err)
			}
			if response, err := svc.CreateProject(
				t.Context(),
				request,
				7,
				true,
			); !errors.Is(err, errorsapi.ErrValidation) || response != nil || repo.writes != 0 ||
				repo.feedbackCalls != 0 {
				t.Fatalf("invalid create reached write/counts: %v", err)
			}
		})
	}
}

func TestProjectMappingAndListScope(t *testing.T) {
	t.Parallel()
	mapper := project.NewMapper()
	if mapper.ToDTO(nil) != nil || mapper.ToCreateDTO(nil, sqlc.CountAutoCreatedEntitiesRow{}) != nil ||
		mapper.ToDTOs(nil) == nil {
		t.Fatal("nil mapping changed")
	}
	for _, scope := range []access.ListScope{{All: true}, {Self: true}, {Down: true}, {ProcessProjects: true}} {
		row := projectFixture()
		repo := &projectRepository{rows: []sqlc.Project{row, {ID: 1, Code: "No owner"}}}
		response, total, err := newService(repo).ListProjects(t.Context(), 7, scope, 9, 20, 40)
		want := []dto.ProjectResponse{
			{
				ID:            3,
				OwnerID:       new(int64(7)),
				ResponsibleID: new(int64(8)),
				Code:          row.Code,
				Color:         new("#ab12EF"),
				StartDate:     row.StartDate,
				EndDate:       row.EndDate,
				Priority:      2,
			},
			{ID: 1, Code: "No owner"},
		}
		if err != nil || total != 17 || !reflect.DeepEqual(response, want) {
			t.Fatalf("mapping/order changed: %+v, %d, %v", response, total, err)
		}
		if repo.user != 7 || repo.owner != 9 || repo.limit != 20 || repo.offset != 40 || repo.counts != 1 ||
			!reflect.DeepEqual(repo.scope, scope) {
			t.Fatalf("scope/pagination changed: %+v", repo)
		}
	}
}

func TestProjectReadDeleteFailures(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name    string
		failure error
	}{
		{"missing", errorsapi.ErrNotFound}, {"nil", nil}, {"database", errors.New("database unavailable")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			repo := &projectRepository{foundErr: tc.failure}
			svc := newService(repo)
			_, err := svc.FindProject(t.Context(), 3)
			want := tc.failure
			if want == nil {
				want = errorsapi.ErrProjectNotFound
			}
			if !errors.Is(err, want) {
				t.Fatalf("find classification changed: %v", err)
			}
			if _, err = svc.UpdateProject(
				t.Context(),
				3,
				dto.UpdateProjectRequest{},
			); !errors.Is(
				err,
				errorsapi.ErrProjectNotFound,
			) {
				t.Fatalf("update classification changed: %v", err)
			}
			err = svc.DeleteProject(t.Context(), 3)
			want = tc.failure
			if errorsapi.IsNotFoundError(want) {
				want = nil
			}
			if !errors.Is(err, want) || repo.writes != 0 {
				t.Fatalf("delete failure/idempotency changed: %v", err)
			}
		})
	}
}

func TestRepositoryFailurePropagation(t *testing.T) {
	t.Parallel()
	failure := errors.New("database unavailable")
	row := projectFixture()
	repo := &projectRepository{row: &row, writeErr: failure}
	svc := newService(repo)
	request := dto.CreateProjectRequest{Code: row.Code, StartDate: row.StartDate, EndDate: row.EndDate}
	if _, err := svc.CreateProject(t.Context(), request, 7, true); !errors.Is(err, failure) || repo.feedbackCalls != 0 {
		t.Fatalf("create failure changed: %v", err)
	}
	if _, err := svc.UpdateProject(t.Context(), 3, dto.UpdateProjectRequest{}); !errors.Is(err, failure) {
		t.Fatalf("update failure changed: %v", err)
	}
	if err := svc.DeleteProject(t.Context(), 3); !errors.Is(err, failure) {
		t.Fatalf("delete failure changed: %v", err)
	}
	for _, first := range []bool{true, false} {
		listRepo := &projectRepository{}
		if first {
			listRepo.listErr = failure
		} else {
			listRepo.countErr = failure
		}
		items, total, err := newService(listRepo).ListProjects(t.Context(), 7, access.ListScope{Down: true}, 0, 50, 0)
		if !errors.Is(err, failure) || items != nil || total != 0 || (first && listRepo.counts != 0) {
			t.Fatalf("list/count failure changed: %+v, %v", listRepo, err)
		}
	}
}
