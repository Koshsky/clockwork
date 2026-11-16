package process_test

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
	process "github.com/Koshsky/erp-backend/internal/project_mgmt/process"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/process/dto"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/process/repository/sqlc"
	"github.com/Koshsky/erp-backend/internal/tracing"
	nullable "github.com/Koshsky/erp-backend/pkg/database"
	"github.com/Koshsky/erp-backend/pkg/date"
	errorsapi "github.com/Koshsky/erp-backend/pkg/errors"
)

type processRepository struct {
	row                                   *sqlc.Process
	rows                                  []sqlc.Process
	foundErr, writeErr, listErr, countErr error
	reads, writes, counts, idReads        int
	user, owner, projectID                int64
	scope                                 access.ListScope
	limit, offset                         int
	reordered                             []int64
}

func processFixture() sqlc.Process {
	return sqlc.Process{
		ID:            3,
		ProjectID:     11,
		OwnerID:       pgtype.Int8{Int64: 7, Valid: true},
		ResponsibleID: pgtype.Int8{Int64: 8, Valid: true},
		Title:         "Процесс <one>",
		Color:         sql.NullString{String: "#ab12EF", Valid: true},
		StartDate:     "2026-12-31",
		EndDate:       "2027-01-02",
		SortOrder:     4,
	}
}
func newService(repo *processRepository) *process.Service {
	return process.NewService(slog.New(slog.DiscardHandler), tracing.New(nil), repo)
}

func (r *processRepository) CreateProcess(
	_ context.Context,
	projectID int64,
	title string,
	color *string,
	owner, responsible *int64,
	start, end date.Date,
) (*sqlc.Process, error) {
	r.writes++
	r.row = &sqlc.Process{
		ID:            3,
		ProjectID:     projectID,
		OwnerID:       nullable.ToInt8(owner),
		ResponsibleID: nullable.ToInt8(responsible),
		Title:         title,
		Color:         nullable.ToString(color),
		StartDate:     start,
		EndDate:       end,
		SortOrder:     4,
	}
	return r.row, r.writeErr
}
func (r *processRepository) FindProcess(context.Context, int64) (*sqlc.Process, error) {
	r.reads++
	if r.row == nil {
		return nil, r.foundErr
	}
	row := *r.row
	return &row, r.foundErr
}
func (r *processRepository) UpdateProcess(_ context.Context, row sqlc.Process) (*sqlc.Process, error) {
	r.writes++
	r.row = &row
	return &row, r.writeErr
}
func (r *processRepository) DeleteProcess(context.Context, int64) error {
	r.writes++
	return r.writeErr
}

func (r *processRepository) ListProcesss(
	_ context.Context,
	user int64,
	scope access.ListScope,
	owner int64,
	limit, offset int,
) ([]sqlc.Process, error) {
	r.user, r.scope, r.owner, r.limit, r.offset = user, scope, owner, limit, offset
	return r.rows, r.listErr
}

func (r *processRepository) CountProcesses(
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
func (r *processRepository) ListProcessIDsByProject(_ context.Context, project int64) ([]int64, error) {
	r.idReads++
	r.projectID = project
	return []int64{1, 2}, r.foundErr
}
func (r *processRepository) ReorderProcesses(_ context.Context, ids []int64) error {
	r.writes++
	r.reordered = ids
	return r.writeErr
}

func TestProcessCreateReadAndDelete(t *testing.T) {
	t.Parallel()
	row := processFixture()
	repo := &processRepository{}
	svc := newService(repo)
	request := dto.CreateProcessRequest{
		ProjectID:     row.ProjectID,
		Title:         row.Title,
		Color:         nullable.StringPtr(row.Color),
		OwnerID:       nullable.Int64Ptr(row.OwnerID),
		ResponsibleID: nullable.Int64Ptr(row.ResponsibleID),
		StartDate:     row.StartDate,
		EndDate:       row.EndDate,
	}
	want := &dto.ProcessResponse{
		ID:            3,
		ProjectID:     11,
		Title:         row.Title,
		Color:         request.Color,
		OwnerID:       request.OwnerID,
		ResponsibleID: request.ResponsibleID,
		StartDate:     row.StartDate,
		EndDate:       row.EndDate,
		Order:         4,
	}
	created, err := svc.CreateProcess(t.Context(), request)
	if err != nil || !reflect.DeepEqual(created, want) || repo.writes != 1 {
		t.Fatalf("create fields changed: %+v, %v", created, err)
	}
	found, err := svc.FindProcess(t.Context(), 3)
	if err != nil || !reflect.DeepEqual(found, want) {
		t.Fatalf("read fields changed: %+v, %v", found, err)
	}
	if err = svc.DeleteProcess(t.Context(), 3); err != nil || repo.writes != 2 {
		t.Fatalf("delete did not reach repository: %v", err)
	}
}

func TestProcessPatchSemantics(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, body string
		change     func(*sqlc.Process)
	}{
		{"absent", `{}`, func(*sqlc.Process) {}},
		{"null", `{"project_id":null,"owner_id":null,"responsible_id":null,"color":null,"start_date":null}`, func(*sqlc.Process) {}},
		{"clear responsible", `{"responsible_id":0}`, func(p *sqlc.Process) { p.ResponsibleID = pgtype.Int8{} }},
		{"clear color", `{"color":""}`, func(p *sqlc.Process) { p.Color = sql.NullString{} }},
		{"replace", `{"project_id":12,"owner_id":9,"responsible_id":10,"title":"Новый <P>","color":"#123456","start_date":"2027-01-01","end_date":"2027-01-05","order":99}`, func(p *sqlc.Process) {
			p.ProjectID = 12
			p.OwnerID = pgtype.Int8{Int64: 9, Valid: true}
			p.ResponsibleID = pgtype.Int8{Int64: 10, Valid: true}
			p.Title = "Новый <P>"
			p.Color = sql.NullString{String: "#123456", Valid: true}
			p.StartDate = "2027-01-01"
			p.EndDate = "2027-01-05"
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			row := processFixture()
			want := row
			tc.change(&want)
			repo := &processRepository{row: &row}
			var request dto.UpdateProcessRequest
			if err := json.Unmarshal([]byte(tc.body), &request); err != nil {
				t.Fatal(err)
			}
			response, err := newService(repo).UpdateProcess(t.Context(), 3, request)
			if err != nil || *repo.row != want || repo.writes != 1 ||
				!reflect.DeepEqual(response, process.NewMapper().ToDTO(&want)) {
				t.Fatalf("patch/order changed: %+v, %v", response, err)
			}
		})
	}
}

func TestProcessValidationBeforeWrite(t *testing.T) {
	t.Parallel()
	for _, body := range []string{`{"project_id":0}`, `{"project_id":-1}`, `{"title":" "}`, `{"color":"red"}`, `{"start_date":""}`, `{"end_date":""}`, `{"end_date":"2026-12-30"}`} {
		t.Run(body, func(t *testing.T) {
			t.Parallel()
			row := processFixture()
			repo := &processRepository{row: &row}
			svc := newService(repo)
			var patch dto.UpdateProcessRequest
			if err := json.Unmarshal([]byte(body), &patch); err != nil {
				t.Fatal(err)
			}
			if response, err := svc.UpdateProcess(
				t.Context(),
				3,
				patch,
			); !errors.Is(err, errorsapi.ErrValidation) || response != nil || repo.writes != 0 ||
				*repo.row != row {
				t.Fatalf("invalid update reached write: %v", err)
			}
			request := dto.CreateProcessRequest{
				ProjectID: 11,
				Title:     row.Title,
				StartDate: row.StartDate,
				EndDate:   row.EndDate,
			}
			if err := json.Unmarshal([]byte(body), &request); err != nil {
				t.Fatal(err)
			}
			if response, err := svc.CreateProcess(
				t.Context(),
				request,
			); !errors.Is(err, errorsapi.ErrValidation) || response != nil ||
				repo.writes != 0 {
				t.Fatalf("invalid create reached write: %v", err)
			}
		})
	}
}

func TestProcessMappingAndListScope(t *testing.T) {
	t.Parallel()
	mapper := process.NewMapper()
	if mapper.ToDTO(nil) != nil || mapper.ToDTOs(nil) == nil || len(mapper.ToDTOs(nil)) != 0 {
		t.Fatal("nil mapping changed")
	}
	for _, scope := range []access.ListScope{{All: true}, {ProjectOwner: true}, {ProcessOwner: true}, {ProjectView: []string{"self"}}} {
		row := processFixture()
		repo := &processRepository{rows: []sqlc.Process{row, {ID: 1, Title: "No owner", SortOrder: 2}}}
		response, total, err := newService(repo).ListProcesses(t.Context(), 7, scope, 9, 20, 40)
		want := []dto.ProcessResponse{
			{
				ID:            3,
				ProjectID:     11,
				OwnerID:       new(int64(7)),
				ResponsibleID: new(int64(8)),
				Title:         row.Title,
				Color:         new("#ab12EF"),
				StartDate:     row.StartDate,
				EndDate:       row.EndDate,
				Order:         4,
			},
			{ID: 1, Title: "No owner", Order: 2},
		}
		if err != nil || total != 17 || !reflect.DeepEqual(response, want) {
			t.Fatalf("list mapping/order changed: %+v, %v", response, err)
		}
		if repo.user != 7 || repo.owner != 9 || repo.limit != 20 || repo.offset != 40 || repo.counts != 1 ||
			!reflect.DeepEqual(repo.scope, scope) {
			t.Fatalf("scope/pagination changed: %+v", repo)
		}
	}
}

func TestProcessReadDeleteFailures(t *testing.T) {
	t.Parallel()
	failure := errors.New("database unavailable")
	for _, tc := range []struct {
		name    string
		failure error
	}{{"missing", errorsapi.ErrNotFound}, {"nil", nil}, {"database", failure}} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			repo := &processRepository{foundErr: tc.failure}
			svc := newService(repo)
			_, err := svc.FindProcess(t.Context(), 3)
			want := errorsapi.ErrProcessNotFound
			if errors.Is(tc.failure, failure) {
				want = failure
			}
			if !errors.Is(err, want) {
				t.Fatalf("find classification changed: %v", err)
			}
			if _, err = svc.UpdateProcess(
				t.Context(),
				3,
				dto.UpdateProcessRequest{},
			); !errors.Is(
				err,
				errorsapi.ErrProcessNotFound,
			) {
				t.Fatalf("update classification changed: %v", err)
			}
			err = svc.DeleteProcess(t.Context(), 3)
			want = nil
			if errors.Is(tc.failure, failure) {
				want = failure
			}
			if !errors.Is(err, want) || repo.writes != 0 {
				t.Fatalf("delete failure/idempotency changed: %v", err)
			}
		})
	}
}

func TestProcessWriteAndListFailures(t *testing.T) {
	t.Parallel()
	failure := errors.New("database unavailable")
	row := processFixture()
	repo := &processRepository{row: &row, writeErr: failure}
	svc := newService(repo)
	request := dto.CreateProcessRequest{ProjectID: 11, Title: row.Title, StartDate: row.StartDate, EndDate: row.EndDate}
	if _, err := svc.CreateProcess(t.Context(), request); !errors.Is(err, failure) {
		t.Fatalf("create failure changed: %v", err)
	}
	if _, err := svc.UpdateProcess(t.Context(), 3, dto.UpdateProcessRequest{}); !errors.Is(err, failure) {
		t.Fatalf("update failure changed: %v", err)
	}
	if err := svc.DeleteProcess(t.Context(), 3); !errors.Is(err, failure) {
		t.Fatalf("delete failure changed: %v", err)
	}
	for _, first := range []bool{true, false} {
		listRepo := &processRepository{}
		if first {
			listRepo.listErr = failure
		} else {
			listRepo.countErr = failure
		}
		items, total, err := newService(listRepo).ListProcesses(t.Context(), 7, access.ListScope{All: true}, 0, 50, 0)
		if !errors.Is(err, failure) || items != nil || total != 0 || (first && listRepo.counts != 0) {
			t.Fatalf("list/count failure changed: %+v, %v", listRepo, err)
		}
	}
}

func TestProcessReorderCompleteGroup(t *testing.T) {
	t.Parallel()
	failure := errors.New("database unavailable")
	for _, tc := range []struct {
		name                        string
		ids                         []int64
		readError, writeError, want error
		reads, writes               int
	}{
		{"empty", nil, nil, nil, errorsapi.ErrValidation, 0, 0},
		{"duplicate", []int64{1, 1}, nil, nil, errorsapi.ErrValidation, 0, 0},
		{"missing", []int64{1}, nil, nil, errorsapi.ErrValidation, 1, 0},
		{"foreign", []int64{1, 9}, nil, nil, errorsapi.ErrValidation, 1, 0},
		{"valid", []int64{2, 1}, nil, nil, nil, 1, 1},
		{"read failure", []int64{2, 1}, failure, nil, failure, 1, 0},
		{"write failure", []int64{2, 1}, nil, failure, failure, 1, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			repo := &processRepository{foundErr: tc.readError, writeErr: tc.writeError}
			err := newService(repo).ReorderProcesses(t.Context(), dto.ReorderProcessRequest{ProjectID: 11, IDs: tc.ids})
			if !errors.Is(err, tc.want) || repo.idReads != tc.reads || repo.writes != tc.writes {
				t.Fatalf("reorder validation changed: %+v, %v", repo, err)
			}
			if tc.reads > 0 && repo.projectID != 11 {
				t.Fatal("reordered wrong project")
			}
			if tc.writes > 0 && !reflect.DeepEqual(repo.reordered, tc.ids) {
				t.Fatalf("reorder changed requested order: %v", repo.reordered)
			}
		})
	}
}
