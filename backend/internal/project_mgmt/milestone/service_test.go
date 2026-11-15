package milestone_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"reflect"
	"testing"

	access "github.com/Koshsky/erp-backend/internal/authz/domain"
	milestone "github.com/Koshsky/erp-backend/internal/project_mgmt/milestone"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/milestone/dto"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/milestone/repository/sqlc"
	"github.com/Koshsky/erp-backend/internal/tracing"
	"github.com/Koshsky/erp-backend/pkg/date"
	errorsapi "github.com/Koshsky/erp-backend/pkg/errors"
)

type milestoneRepo struct {
	row                *sqlc.Milestone
	rows               []sqlc.Milestone
	foundErr, writeErr error
	listErr, countErr  error
	writes             int
	counts             int
	user, owner        int64
	scope              access.ListScope
	limit, offset      int
}

func fixture() sqlc.Milestone {
	return sqlc.Milestone{ID: 3, ProcessID: 7, Title: "Title", Content: "Content", Date: "2026-11-20",
		Color: sql.NullString{String: "#123456", Valid: true}}
}

func newService(repo *milestoneRepo) *milestone.Service {
	return milestone.NewService(slog.New(slog.DiscardHandler), tracing.New(nil), repo)
}

func (r *milestoneRepo) CreateMilestone(_ context.Context, processID int64, title, content string,
	color *string, day date.Date,
) (*sqlc.Milestone, error) {
	r.writes++
	row := sqlc.Milestone{ID: 3, ProcessID: processID, Title: title, Content: content, Date: day}
	if color != nil {
		row.Color = sql.NullString{String: *color, Valid: true}
	}
	r.row = &row
	return r.row, r.writeErr
}

func (r *milestoneRepo) FindMilestone(context.Context, int64) (*sqlc.Milestone, error) {
	if r.row == nil {
		return nil, r.foundErr
	}
	row := *r.row
	return &row, r.foundErr
}

func (r *milestoneRepo) UpdateMilestone(_ context.Context, row sqlc.Milestone) (*sqlc.Milestone, error) {
	r.writes++
	r.row = &row
	return r.row, r.writeErr
}

func (r *milestoneRepo) DeleteMilestone(context.Context, int64) error {
	r.writes++
	return r.writeErr
}

func (r *milestoneRepo) ListMilestones(_ context.Context, user int64, scope access.ListScope,
	owner int64, limit, offset int,
) ([]sqlc.Milestone, error) {
	r.user, r.scope, r.owner, r.limit, r.offset = user, scope, owner, limit, offset
	return r.rows, r.listErr
}

func (r *milestoneRepo) CountMilestones(
	_ context.Context,
	user int64,
	scope access.ListScope,
	owner int64,
) (int64, error) {
	r.counts++
	if user != r.user || owner != r.owner || !reflect.DeepEqual(scope, r.scope) {
		return 0, errors.New("list and count filters differ")
	}
	return 19, r.countErr
}

func TestMilestoneCreateAndFind(t *testing.T) {
	t.Parallel()
	for _, color := range []*string{nil, new(""), new("#Ab12EF")} {
		repo := &milestoneRepo{}
		svc := newService(repo)
		created, err := svc.CreateMilestone(t.Context(), dto.CreateMilestoneRequest{
			ProcessID: 7, Title: " Title ", Content: "Content", Date: "2026-11-20", Color: color,
		})
		if err != nil || repo.writes != 1 || created.ID != 3 || created.Title != " Title " ||
			created.ProcessID != 7 || created.Date != "2026-11-20" {
			t.Fatalf("create changed fields: %+v, %v", created, err)
		}
		found, err := svc.FindMilestone(t.Context(), created.ID)
		if err != nil || !reflect.DeepEqual(found, created) {
			t.Fatalf("find changed response: %+v, %v", found, err)
		}
		if err = svc.DeleteMilestone(t.Context(), created.ID); err != nil || repo.writes != 2 {
			t.Fatalf("delete did not reach the repository: %v", err)
		}
	}
}

func TestMilestoneValidator(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, field string
		change      func(*dto.CreateMilestoneRequest)
	}{
		{"zero process", "process_id", func(r *dto.CreateMilestoneRequest) { r.ProcessID = 0 }},
		{"negative process", "process_id", func(r *dto.CreateMilestoneRequest) { r.ProcessID = -1 }},
		{"empty title", "title", func(r *dto.CreateMilestoneRequest) { r.Title = " \t" }},
		{"empty content", "content", func(r *dto.CreateMilestoneRequest) { r.Content = "\n" }},
		{"short color", "color", func(r *dto.CreateMilestoneRequest) { r.Color = new("#fff") }},
		{"invalid color", "color", func(r *dto.CreateMilestoneRequest) { r.Color = new("red") }},
		{"missing date", "date", func(r *dto.CreateMilestoneRequest) { r.Date = "" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			req := dto.CreateMilestoneRequest{ProcessID: 7, Title: "Title", Content: "Content", Date: "2026-11-20"}
			tc.change(&req)
			var validator milestone.Validator
			err := validator.ValidateMilestone(req.ProcessID, req.Title, req.Content, req.Color, req.Date)
			var field *errorsapi.FieldError
			if !errors.As(err, &field) || field.Field != tc.field || !errors.Is(err, errorsapi.ErrValidation) {
				t.Fatalf("wrong field error: %+v", err)
			}
		})
	}
}

func TestMilestoneInvalidWritesDoNotReachRepository(t *testing.T) {
	t.Parallel()
	row := fixture()
	repo := &milestoneRepo{row: &row}
	svc := newService(repo)
	if _, err := svc.CreateMilestone(
		t.Context(),
		dto.CreateMilestoneRequest{},
	); !errors.Is(
		err,
		errorsapi.ErrValidation,
	) {
		t.Fatalf("invalid create accepted: %v", err)
	}
	if _, err := svc.UpdateMilestone(
		t.Context(),
		row.ID,
		dto.UpdateMilestoneRequest{Date: new(date.Date(""))},
	); !errors.Is(
		err,
		errorsapi.ErrValidation,
	) {
		t.Fatalf("invalid update accepted: %v", err)
	}
	if repo.writes != 0 || *repo.row != row {
		t.Fatal("invalid request changed stored data")
	}
}

func TestMilestonePatchSemantics(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, body string
		change     func(*sqlc.Milestone)
	}{
		{"absent", `{}`, func(*sqlc.Milestone) {}},
		{"null", `{"title":null,"content":null,"date":null,"color":null,"process_id":null}`, func(*sqlc.Milestone) {}},
		{"clear color", `{"color":""}`, func(r *sqlc.Milestone) { r.Color = sql.NullString{} }},
		{"replace", `{"title":"New","content":"Text","date":"2026-12-01","color":"#abcdef","process_id":8}`,
			func(r *sqlc.Milestone) {
				r.Title, r.Content, r.Date, r.ProcessID = "New", "Text", "2026-12-01", 8
				r.Color = sql.NullString{String: "#abcdef", Valid: true}
			}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			row, want := fixture(), fixture()
			tc.change(&want)
			repo := &milestoneRepo{row: &row}
			var req dto.UpdateMilestoneRequest
			if err := json.Unmarshal([]byte(tc.body), &req); err != nil {
				t.Fatal(err)
			}
			if _, err := newService(
				repo,
			).UpdateMilestone(t.Context(), row.ID, req); err != nil || *repo.row != want ||
				repo.writes != 1 {
				t.Fatalf("patch semantics changed: %+v, %v", repo.row, err)
			}
		})
	}
}

func TestMilestoneMapper(t *testing.T) {
	t.Parallel()
	mapper := milestone.NewMapper()
	if mapper.ToDTO(nil) != nil || mapper.ToDTOs(nil) == nil || len(mapper.ToDTOs(nil)) != 0 {
		t.Fatal("mapper changed nil/empty response contract")
	}
	for _, color := range []sql.NullString{{String: "ignored"}, {Valid: true}, {String: "#abcdef", Valid: true}} {
		row := fixture()
		row.Color = color
		response := mapper.ToDTO(&row)
		wantColor := (*string)(nil)
		if color.Valid && color.String != "" {
			wantColor = &color.String
		}
		want := dto.MilestoneResponse{
			ID:        3,
			ProcessID: 7,
			Title:     "Title",
			Content:   "Content",
			Date:      "2026-11-20",
			Color:     wantColor,
		}
		if !reflect.DeepEqual(*response, want) {
			t.Fatalf("mapper changed payload: %+v", response)
		}
		rows := mapper.ToDTOs([]sqlc.Milestone{row, {ID: 1}})
		if rows[0].ID != 3 || rows[1].ID != 1 {
			t.Fatal("mapper changed repository ordering")
		}
	}
}

func TestMilestoneListForwardsScopeAndPagination(t *testing.T) {
	t.Parallel()
	for _, scope := range []access.ListScope{{All: true}, {ProcessOwner: true}, {ProjectOwner: true},
		{ProjectView: []string{"self"}, ProcessView: []string{"process_owner"}}} {
		repo := &milestoneRepo{rows: []sqlc.Milestone{fixture()}}
		items, total, err := newService(repo).ListMilestones(t.Context(), 7, scope, 8, 20, 40)
		if err != nil || total != 19 || len(items) != 1 || repo.counts != 1 ||
			repo.user != 7 || repo.owner != 8 || repo.limit != 20 || repo.offset != 40 || !reflect.DeepEqual(repo.scope, scope) {
			t.Fatalf("list filters or independent count changed: %+v, %d, %v", repo, total, err)
		}
	}
}

func TestMilestoneRepositoryFailures(t *testing.T) {
	t.Parallel()
	failure := errors.New("database unavailable")
	for _, tc := range []struct {
		name string
		run  func(*milestone.Service) error
		repo milestoneRepo
		want error
	}{
		{"create", func(s *milestone.Service) error {
			_, err := s.CreateMilestone(t.Context(), dto.CreateMilestoneRequest{ProcessID: 7, Title: "T", Content: "C", Date: "2026-11-20"})
			return err
		}, milestoneRepo{writeErr: failure}, failure},
		{"find error", func(s *milestone.Service) error { _, err := s.FindMilestone(t.Context(), 3); return err },
			milestoneRepo{foundErr: failure}, failure},
		{"find missing", func(s *milestone.Service) error { _, err := s.FindMilestone(t.Context(), 3); return err },
			milestoneRepo{foundErr: errorsapi.ErrNotFound}, errorsapi.ErrMilestoneNotFound},
		{"find nil", func(s *milestone.Service) error { _, err := s.FindMilestone(t.Context(), 3); return err },
			milestoneRepo{}, errorsapi.ErrMilestoneNotFound},
		{"update fetch error", func(s *milestone.Service) error {
			_, err := s.UpdateMilestone(t.Context(), 3, dto.UpdateMilestoneRequest{})
			return err
		},
			milestoneRepo{foundErr: failure}, errorsapi.ErrMilestoneNotFound},
		{"update write", func(s *milestone.Service) error {
			_, err := s.UpdateMilestone(t.Context(), 3, dto.UpdateMilestoneRequest{})
			return err
		},
			milestoneRepo{row: new(fixture()), writeErr: failure}, failure},
		{"delete missing", func(s *milestone.Service) error { return s.DeleteMilestone(t.Context(), 3) },
			milestoneRepo{foundErr: errorsapi.ErrNotFound}, nil},
		{"delete nil", func(s *milestone.Service) error { return s.DeleteMilestone(t.Context(), 3) }, milestoneRepo{}, nil},
		{"delete fetch error", func(s *milestone.Service) error { return s.DeleteMilestone(t.Context(), 3) }, milestoneRepo{foundErr: failure}, failure},
		{"delete write", func(s *milestone.Service) error { return s.DeleteMilestone(t.Context(), 3) },
			milestoneRepo{row: new(fixture()), writeErr: failure}, failure},
		{"list", func(s *milestone.Service) error {
			_, _, err := s.ListMilestones(t.Context(), 7, access.ListScope{}, 0, 50, 0)
			return err
		},
			milestoneRepo{listErr: failure}, failure},
		{"count", func(s *milestone.Service) error {
			_, _, err := s.ListMilestones(t.Context(), 7, access.ListScope{}, 0, 50, 0)
			return err
		},
			milestoneRepo{countErr: failure}, failure},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if err := tc.run(newService(&tc.repo)); !errors.Is(err, tc.want) {
				t.Fatalf("error classification changed: %v, want %v", err, tc.want)
			}
		})
	}
}
