package service_test

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"reflect"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"

	access "github.com/Koshsky/erp-backend/internal/authz/domain"
	"github.com/Koshsky/erp-backend/internal/planning/dto"
	"github.com/Koshsky/erp-backend/internal/planning/repository/sqlc"
	"github.com/Koshsky/erp-backend/internal/planning/service"
	"github.com/Koshsky/erp-backend/internal/tracing"
)

type projectPlanningRepository struct {
	service.PlanningRepository

	rows  []sqlc.Project
	err   error
	user  int64
	scope access.ListScope
}

func (r *projectPlanningRepository) ListProjects(
	_ context.Context,
	user int64,
	scope access.ListScope,
) ([]sqlc.Project, error) {
	r.user, r.scope = user, scope
	return r.rows, r.err
}

func TestProjectPlanningScopeAndFields(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name  string
		scope access.ListScope
	}{
		{"own", access.ListScope{Self: true}}, {"process or task descendant", access.ListScope{Down: true}},
		{"owned process project", access.ListScope{ProcessProjects: true}}, {"all", access.ListScope{All: true}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			repo := &projectPlanningRepository{
				rows: []sqlc.Project{
					{
						ID:            3,
						OwnerID:       pgtype.Int8{Int64: 9, Valid: true},
						ResponsibleID: pgtype.Int8{Int64: 8, Valid: true},
						Code:          "Проект <one>",
						Color:         sql.NullString{String: "#123456", Valid: true},
						StartDate:     "2026-12-31",
						EndDate:       "2027-01-03",
						Priority:      2,
					},
					{ID: 1, Code: "Empty"},
				},
			}
			svc := service.NewPlanningService(slog.New(slog.DiscardHandler), tracing.New(nil), repo)
			response, err := svc.GetProjectPlanning(t.Context(), 7, tc.scope)
			want := &dto.ProjectPlanning{
				Projects: []dto.Project{
					{
						ID:            3,
						OwnerID:       new(int64(9)),
						ResponsibleID: new(int64(8)),
						Code:          "Проект <one>",
						Color:         new("#123456"),
						StartDate:     "2026-12-31",
						EndDate:       "2027-01-03",
						Priority:      2,
					},
					{ID: 1, Code: "Empty"},
				},
			}
			if err != nil || !reflect.DeepEqual(response, want) || repo.user != 7 ||
				!reflect.DeepEqual(repo.scope, tc.scope) {
				t.Fatalf("planning fields/scope changed: %+v, %v", response, err)
			}
		})
	}
}

func TestProjectPlanningEmptyAndReadFailure(t *testing.T) {
	t.Parallel()
	for _, failure := range []error{nil, errors.New("planning read failed")} {
		repo := &projectPlanningRepository{err: failure}
		response, err := service.NewPlanningService(slog.New(slog.DiscardHandler), tracing.New(nil), repo).
			GetProjectPlanning(t.Context(), 7, access.ListScope{Down: true})
		if !errors.Is(err, failure) {
			t.Fatalf("planning error changed: %v", err)
		}
		if failure == nil && (response == nil || response.Projects == nil || len(response.Projects) != 0) {
			t.Fatalf("empty planning changed: %+v", response)
		}
		if failure != nil && response != nil {
			t.Fatal("failed planning returned data")
		}
	}
}
