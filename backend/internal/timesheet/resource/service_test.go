package resource_test

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
	resource "github.com/Koshsky/erp-backend/internal/timesheet/resource"
	"github.com/Koshsky/erp-backend/internal/timesheet/resource/dto"
	"github.com/Koshsky/erp-backend/internal/timesheet/resource/repository/sqlc"
	"github.com/Koshsky/erp-backend/internal/tracing"
	nullable "github.com/Koshsky/erp-backend/pkg/database"
	"github.com/Koshsky/erp-backend/pkg/date"
	errorsapi "github.com/Koshsky/erp-backend/pkg/errors"
)

type resourceRepository struct {
	resource.Repository

	row                                                                      *sqlc.ListResourcesRow
	rows                                                                     []sqlc.ListResourcesRow
	foundErr, writeErr, listErr, countErr, managerErr, memberErr, absenceErr error
	writes, counts, managerReads, memberReads, absenceReads                  int
	user, owner, resourceID, memberID                                        int64
	scope                                                                    access.ListScope
	limit, offset                                                            int
	manager                                                                  *int64
	members                                                                  []sqlc.ListMembersByResourceIDRow
	absences                                                                 []sqlc.ListResourceAbsenceRow
	start, end                                                               date.Date
}

func resourceFixture() sqlc.ListResourcesRow {
	return sqlc.ListResourcesRow{
		ID:             3,
		Code:           "R",
		Title:          "Ресурс <one>",
		Color:          sql.NullString{String: "#ab12EF", Valid: true},
		OwnerID:        7,
		EmployeesCount: 4,
	}
}
func newService(repo *resourceRepository) *resource.Service {
	return resource.NewService(slog.New(slog.DiscardHandler), tracing.New(nil), repo)
}

func (r *resourceRepository) CreateResource(
	_ context.Context,
	code, title string,
	color *string,
	owner *int64,
) (*sqlc.ListResourcesRow, error) {
	r.writes++
	r.row = &sqlc.ListResourcesRow{
		ID:             3,
		Code:           code,
		Title:          title,
		Color:          nullable.ToString(color),
		OwnerID:        *owner,
		EmployeesCount: 4,
	}
	return r.row, r.writeErr
}
func (r *resourceRepository) FindResource(context.Context, int64) (*sqlc.ListResourcesRow, error) {
	if r.row == nil {
		return nil, r.foundErr
	}
	row := *r.row
	return &row, r.foundErr
}

func (r *resourceRepository) UpdateResource(
	_ context.Context,
	id int64,
	code, title string,
	color *string,
	owner *int64,
) (*sqlc.ListResourcesRow, error) {
	r.writes++
	r.row = &sqlc.ListResourcesRow{
		ID:             id,
		Code:           code,
		Title:          title,
		Color:          nullable.ToString(color),
		OwnerID:        *owner,
		EmployeesCount: 4,
	}
	return r.row, r.writeErr
}
func (r *resourceRepository) DeleteResource(context.Context, int64) error {
	r.writes++
	return r.writeErr
}

func (r *resourceRepository) ListResources(
	_ context.Context,
	user int64,
	scope access.ListScope,
	owner int64,
	limit, offset int,
) ([]sqlc.ListResourcesRow, error) {
	r.user, r.scope, r.owner, r.limit, r.offset = user, scope, owner, limit, offset
	return r.rows, r.listErr
}

func (r *resourceRepository) CountResources(
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
func (r *resourceRepository) FindUserManager(_ context.Context, user int64) (*int64, error) {
	r.managerReads++
	r.memberID = user
	return r.manager, r.managerErr
}
func (r *resourceRepository) AddMember(_ context.Context, resource, user int64) error {
	r.writes++
	r.resourceID, r.memberID = resource, user
	return r.memberErr
}
func (r *resourceRepository) RemoveMember(_ context.Context, resource, user int64) error {
	r.writes++
	r.resourceID, r.memberID = resource, user
	return r.memberErr
}

func (r *resourceRepository) ListMembersByResourceID(
	_ context.Context,
	id int64,
) ([]sqlc.ListMembersByResourceIDRow, error) {
	r.memberReads++
	r.resourceID = id
	return r.members, r.memberErr
}

func (r *resourceRepository) ListAbsence(
	_ context.Context,
	id int64,
	start, end date.Date,
) ([]sqlc.ListResourceAbsenceRow, error) {
	r.absenceReads++
	r.resourceID, r.start, r.end = id, start, end
	return r.absences, r.absenceErr
}

func TestResourceCreationOwnerAndCount(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name  string
		owner *int64
		want  int64
	}{{"default owner", nil, 7}, {"explicit owner", new(int64(9)), 9}} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			repo := &resourceRepository{}
			svc := newService(repo)
			response, err := svc.CreateResource(
				t.Context(),
				dto.CreateResourceRequest{Code: "R", Title: "Ресурс <one>", Color: new("#ab12EF"), OwnerID: tc.owner},
				7,
			)
			want := &dto.ResourceResponse{
				ID:             3,
				Code:           "R",
				Title:          "Ресурс <one>",
				Color:          new("#ab12EF"),
				OwnerID:        new(tc.want),
				EmployeesCount: 4,
			}
			if err != nil || !reflect.DeepEqual(response, want) || repo.writes != 1 {
				t.Fatalf("resource create changed fields/count: %+v, %v", response, err)
			}
			found, err := svc.FindResource(t.Context(), 3)
			if err != nil || !reflect.DeepEqual(found, want) {
				t.Fatalf("resource read changed fields/count: %+v, %v", found, err)
			}
			if err = svc.DeleteResource(t.Context(), 3); err != nil || repo.writes != 2 {
				t.Fatalf("delete failed: %v", err)
			}
		})
	}
}

func TestResourcePatchRetainsFieldsAndCount(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, body string
		change     func(*sqlc.ListResourcesRow)
	}{
		{"absent", `{}`, func(*sqlc.ListResourcesRow) {}},
		{"null", `{"owner_id":null,"color":null,"code":null,"title":null}`, func(*sqlc.ListResourcesRow) {}},
		{"clear color", `{"color":""}`, func(r *sqlc.ListResourcesRow) { r.Color = sql.NullString{} }},
		{"replace", `{"owner_id":9,"code":"N","title":"Новый <R>","color":"#123456"}`, func(r *sqlc.ListResourcesRow) {
			r.OwnerID = 9
			r.Code = "N"
			r.Title = "Новый <R>"
			r.Color = sql.NullString{String: "#123456", Valid: true}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			row := resourceFixture()
			want := row
			tc.change(&want)
			repo := &resourceRepository{row: &row}
			var request dto.UpdateResourceRequest
			if err := json.Unmarshal([]byte(tc.body), &request); err != nil {
				t.Fatal(err)
			}
			response, err := newService(repo).UpdateResource(t.Context(), 3, request)
			if err != nil || *repo.row != want || repo.writes != 1 ||
				!reflect.DeepEqual(response, resource.NewMapper().ToDTO(&want)) {
				t.Fatalf("resource patch changed fields/count: %+v, %v", response, err)
			}
		})
	}
}

func TestResourceValidationBeforeWrite(t *testing.T) {
	t.Parallel()
	for _, body := range []string{`{"code":" "}`, `{"title":" "}`, `{"color":"red"}`} {
		t.Run(body, func(t *testing.T) {
			t.Parallel()
			row := resourceFixture()
			repo := &resourceRepository{row: &row}
			svc := newService(repo)
			var patch dto.UpdateResourceRequest
			if err := json.Unmarshal([]byte(body), &patch); err != nil {
				t.Fatal(err)
			}
			if response, err := svc.UpdateResource(
				t.Context(),
				3,
				patch,
			); !errors.Is(err, errorsapi.ErrValidation) || response != nil || repo.writes != 0 ||
				*repo.row != row {
				t.Fatalf("invalid patch persisted: %v", err)
			}
			request := dto.CreateResourceRequest{Code: "R", Title: "Resource"}
			if err := json.Unmarshal([]byte(body), &request); err != nil {
				t.Fatal(err)
			}
			if response, err := svc.CreateResource(
				t.Context(),
				request,
				7,
			); !errors.Is(err, errorsapi.ErrValidation) || response != nil ||
				repo.writes != 0 {
				t.Fatalf("invalid create persisted: %v", err)
			}
		})
	}
}

func TestResourceListScopeAndNullableMapping(t *testing.T) {
	t.Parallel()
	mapper := resource.NewMapper()
	if mapper.ToDTO(nil) != nil || mapper.ToDTOs(nil) == nil || mapper.ToMemberDTO(nil) != nil ||
		mapper.ToMemberDTOs(nil) == nil ||
		mapper.ToAbsenceDTOs(nil) == nil {
		t.Fatal("nil mapping changed")
	}
	for _, scope := range []access.ListScope{{All: true}, {Self: true}, {ProjectResources: true}} {
		repo := &resourceRepository{
			rows: []sqlc.ListResourcesRow{resourceFixture(), {ID: 1, Code: "Empty", OwnerID: 9}},
		}
		items, total, err := newService(repo).ListResources(t.Context(), 7, scope, 9, 20, 40)
		want := []dto.ResourceResponse{
			{ID: 3, Code: "R", Title: "Ресурс <one>", Color: new("#ab12EF"), OwnerID: new(int64(7)), EmployeesCount: 4},
			{ID: 1, Code: "Empty", OwnerID: new(int64(9))},
		}
		if err != nil || total != 17 || !reflect.DeepEqual(items, want) {
			t.Fatalf("list mapping/count/order changed: %+v, %v", items, err)
		}
		if repo.user != 7 || repo.owner != 9 || repo.limit != 20 || repo.offset != 40 || repo.counts != 1 ||
			!reflect.DeepEqual(repo.scope, scope) {
			t.Fatalf("scope/pagination changed: %+v", repo)
		}
	}
}

func TestResourceReadDeleteFailureSemantics(t *testing.T) {
	t.Parallel()
	failure := errors.New("database unavailable")
	for _, tc := range []struct {
		name    string
		failure error
	}{{"missing", errorsapi.ErrNotFound}, {"nil", nil}, {"database", failure}} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			repo := &resourceRepository{foundErr: tc.failure}
			svc := newService(repo)
			_, err := svc.FindResource(t.Context(), 3)
			want := errorsapi.ErrResourceNotFound
			if errors.Is(tc.failure, failure) {
				want = failure
			}
			if !errors.Is(err, want) {
				t.Fatalf("read classification changed: %v", err)
			}
			if _, err = svc.UpdateResource(
				t.Context(),
				3,
				dto.UpdateResourceRequest{},
			); !errors.Is(
				err,
				errorsapi.ErrResourceNotFound,
			) {
				t.Fatalf("update classification changed: %v", err)
			}
			err = svc.DeleteResource(t.Context(), 3)
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

func TestResourceWriteAndListFailures(t *testing.T) {
	t.Parallel()
	failure := errors.New("database unavailable")
	repo := &resourceRepository{row: new(resourceFixture()), writeErr: failure}
	svc := newService(repo)
	if _, err := svc.CreateResource(
		t.Context(),
		dto.CreateResourceRequest{Code: "R", Title: "Resource"},
		7,
	); !errors.Is(
		err,
		failure,
	) {
		t.Fatalf("create failure changed: %v", err)
	}
	if _, err := svc.UpdateResource(t.Context(), 3, dto.UpdateResourceRequest{}); !errors.Is(err, failure) {
		t.Fatalf("update failure changed: %v", err)
	}
	if err := svc.DeleteResource(t.Context(), 3); !errors.Is(err, failure) {
		t.Fatalf("delete failure changed: %v", err)
	}
	for _, first := range []bool{true, false} {
		listRepo := &resourceRepository{}
		if first {
			listRepo.listErr = failure
		} else {
			listRepo.countErr = failure
		}
		items, total, err := newService(listRepo).ListResources(t.Context(), 7, access.ListScope{All: true}, 0, 50, 0)
		if !errors.Is(err, failure) || items != nil || total != 0 || (first && listRepo.counts != 0) {
			t.Fatalf("list/count failure changed: %+v, %v", listRepo, err)
		}
	}
}

func TestResourceMemberHierarchy(t *testing.T) {
	t.Parallel()
	failure := errors.New("member repository unavailable")
	for _, tc := range []struct {
		name                        string
		resource, user              int64
		admin                       bool
		manager                     *int64
		managerErr, memberErr, want error
		reads, writes               int
	}{
		{"self", 3, 7, false, nil, nil, nil, nil, 0, 1},
		{"direct subordinate", 3, 8, false, new(int64(7)), nil, nil, nil, 1, 1},
		{"indirect subordinate", 3, 8, false, new(int64(9)), nil, nil, errorsapi.ErrForbidden, 1, 0},
		{"no manager", 3, 8, false, nil, nil, nil, errorsapi.ErrForbidden, 1, 0},
		{"admin any member", 3, 8, true, nil, nil, nil, nil, 0, 1},
		{"invalid resource", 0, 8, false, nil, nil, nil, errorsapi.ErrValidation, 0, 0},
		{"invalid member", 3, 0, false, nil, nil, nil, errorsapi.ErrValidation, 0, 0},
		{"manager read fails", 3, 8, false, nil, failure, nil, failure, 1, 0},
		{"member write fails", 3, 8, false, new(int64(7)), nil, failure, failure, 1, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			repo := &resourceRepository{manager: tc.manager, managerErr: tc.managerErr, memberErr: tc.memberErr}
			err := newService(repo).AddMember(t.Context(), tc.resource, tc.user, 7, tc.admin)
			if !errors.Is(err, tc.want) || repo.managerReads != tc.reads || repo.writes != tc.writes {
				t.Fatalf("hierarchy changed: %+v, %v", repo, err)
			}
			if tc.writes > 0 && (repo.resourceID != tc.resource || repo.memberID != tc.user) {
				t.Fatal("member write targeted wrong IDs")
			}
		})
	}
}

func TestResourceMembersMappingAndRemoval(t *testing.T) {
	t.Parallel()
	repo := &resourceRepository{
		members: []sqlc.ListMembersByResourceIDRow{
			{
				ID:        8,
				Name:      "Сотрудник <one>",
				Preset:    sql.NullString{String: "worker", Valid: true},
				Position:  "Инженер",
				ManagerID: pgtype.Int8{Int64: 7, Valid: true},
				HireDate:  pgtype.Date{Time: date.Date("2024-01-15").Time(), Valid: true},
			},
			{ID: 9, Name: "Empty", TerminationDate: pgtype.Date{Time: date.Date("2026-12-31").Time(), Valid: true}},
		},
	}
	svc := newService(repo)
	items, err := svc.ListMembers(t.Context(), 3)
	want := []dto.ResourceMemberResponse{
		{
			ID:        8,
			Name:      "Сотрудник <one>",
			Preset:    new("worker"),
			Position:  "Инженер",
			ManagerID: new(int64(7)),
			HireDate:  new(date.Date("2024-01-15")),
		},
		{ID: 9, Name: "Empty", TerminationDate: new(date.Date("2026-12-31"))},
	}
	if err != nil || !reflect.DeepEqual(items, want) || repo.resourceID != 3 {
		t.Fatalf("member mapping/dates changed: %+v, %v", items, err)
	}
	for range 2 {
		if err = svc.RemoveMember(t.Context(), 3, 8); err != nil {
			t.Fatal(err)
		}
	}
	if repo.writes != 2 || repo.memberID != 8 || repo.resourceID != 3 {
		t.Fatal("repeated remove lost IDs")
	}
	if err = svc.RemoveMember(t.Context(), 0, 8); !errors.Is(err, errorsapi.ErrValidation) || repo.writes != 2 {
		t.Fatalf("invalid remove persisted: %v", err)
	}
	if err = svc.RemoveMember(t.Context(), 3, 0); !errors.Is(err, errorsapi.ErrValidation) || repo.writes != 2 {
		t.Fatalf("invalid user persisted: %v", err)
	}
	failure := errors.New("member repository unavailable")
	repo.memberErr = failure
	if _, err = svc.ListMembers(t.Context(), 3); !errors.Is(err, failure) {
		t.Fatalf("member read error changed: %v", err)
	}
	if err = svc.RemoveMember(t.Context(), 3, 8); !errors.Is(err, failure) {
		t.Fatalf("member write error changed: %v", err)
	}
}

func TestResourceAbsenceWindowAndMapping(t *testing.T) {
	t.Parallel()
	start := date.Date("2026-01-01")
	last := date.From(start.Time().AddDate(0, 0, 3660))
	tooLate := date.From(start.Time().AddDate(0, 0, 3661))
	for _, tc := range []struct {
		name       string
		resource   int64
		start, end date.Date
		invalid    bool
	}{
		{"single day", 3, start, start, false}, {"year boundary", 3, "2026-12-31", "2027-01-02", false}, {"maximum window", 3, start, last, false},
		{"zero resource", 0, start, start, true}, {"missing start", 3, "", start, true}, {"missing end", 3, start, "", true},
		{"reversed", 3, "2026-01-02", start, true}, {"too wide", 3, start, tooLate, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			row := sqlc.ListResourceAbsenceRow{
				UserID:    8,
				UserName:  "Сотрудник",
				StateID:   4,
				StateCode: "ОТП",
				StateName: "Отпуск",
				StartDate: tc.start,
				EndDate:   tc.end,
			}
			repo := &resourceRepository{absences: []sqlc.ListResourceAbsenceRow{row}}
			response, err := newService(repo).ListAbsence(t.Context(), tc.resource, tc.start, tc.end)
			if tc.invalid {
				if !errors.Is(err, errorsapi.ErrValidation) || repo.absenceReads != 0 {
					t.Fatalf("invalid absence query executed: %v", err)
				}
				return
			}
			want := []dto.ResourceAbsenceResponse{
				{
					UserID:    8,
					UserName:  "Сотрудник",
					StateID:   4,
					StateCode: "ОТП",
					StateName: "Отпуск",
					StartDate: tc.start,
					EndDate:   tc.end,
				},
			}
			if err != nil || !reflect.DeepEqual(response, want) || repo.resourceID != 3 || repo.start != tc.start ||
				repo.end != tc.end {
				t.Fatalf("absence mapping/window changed: %+v, %v", response, err)
			}
			failure := errors.New("absence read unavailable")
			repo.absenceErr = failure
			if _, err = newService(repo).ListAbsence(t.Context(), 3, tc.start, tc.end); !errors.Is(err, failure) {
				t.Fatalf("absence error changed: %v", err)
			}
		})
	}
}
