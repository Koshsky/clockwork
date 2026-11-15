package service_test

import (
	"context"
	"database/sql"
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

type processPlanningRepository struct {
	service.PlanningRepository

	processScope, projectScope access.ListScope
	processUser, projectUser   int64
	projectIDs                 []int64
}

func (r *processPlanningRepository) ListProcesses(
	_ context.Context,
	user int64,
	scope access.ListScope,
) ([]sqlc.ListProcessesRow, error) {
	r.processUser, r.processScope = user, scope
	return []sqlc.ListProcessesRow{
		{
			Process: sqlc.Process{
				ID:            2,
				ProjectID:     11,
				OwnerID:       pgtype.Int8{Int64: 8, Valid: true},
				ResponsibleID: pgtype.Int8{Int64: 9, Valid: true},
				Title:         "Процесс <one>",
				Color:         sql.NullString{String: "#123456", Valid: true},
				StartDate:     "2026-12-31",
				EndDate:       "2027-01-03",
				SortOrder:     1,
			},
			ProjectCode:    "P",
			ProjectOwnerID: pgtype.Int8{Int64: 7, Valid: true},
		},
		{Process: sqlc.Process{ID: 1, ProjectID: 11, Title: "Empty", SortOrder: 2}, ProjectCode: "P"},
	}, nil
}

func (r *processPlanningRepository) ListProjectsByIDs(
	_ context.Context,
	ids []int64,
	user int64,
	scope access.ListScope,
) ([]sqlc.Project, error) {
	r.projectIDs, r.projectUser, r.projectScope = ids, user, scope
	return []sqlc.Project{{ID: 11, Code: "P", OwnerID: pgtype.Int8{Int64: 7, Valid: true}, Priority: 2}}, nil
}

func TestProcessPlanningPreservesScopesFieldsAndOrder(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name  string
		scope access.ListScope
	}{
		{"all", access.ListScope{All: true}}, {"project owner", access.ListScope{ProjectOwner: true}},
		{"process owner", access.ListScope{ProcessOwner: true}}, {"inherited project", access.ListScope{ProjectView: []string{"self"}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			repo := &processPlanningRepository{}
			projectScope := access.ListScope{Self: true}
			response, err := service.NewPlanningService(slog.New(slog.DiscardHandler), tracing.New(nil), repo).
				GetProcessPlanning(t.Context(), 7, tc.scope, projectScope)
			parent := dto.Project{ID: 11, Code: "P", OwnerID: new(int64(7)), Priority: 2}
			want := &dto.ProcessPlanning{
				Projects: []dto.DetailedProject{
					{
						Project: parent,
						Processes: []dto.Process{
							{
								ID:             2,
								ProjectID:      11,
								ProjectCode:    "P",
								ProjectOwnerID: new(int64(7)),
								OwnerID:        new(int64(8)),
								ResponsibleID:  new(int64(9)),
								Title:          "Процесс <one>",
								Color:          new("#123456"),
								StartDate:      "2026-12-31",
								EndDate:        "2027-01-03",
								Order:          1,
							},
							{ID: 1, ProjectID: 11, ProjectCode: "P", Title: "Empty", Order: 2},
						},
					},
				},
			}
			if err != nil || !reflect.DeepEqual(response, want) {
				t.Fatalf("planning fields/order changed: %+v, %v", response, err)
			}
			if repo.processUser != 7 || repo.projectUser != 7 || !reflect.DeepEqual(repo.processScope, tc.scope) ||
				!reflect.DeepEqual(repo.projectScope, projectScope) ||
				!reflect.DeepEqual(repo.projectIDs, []int64{11}) {
				t.Fatalf("planning scope/parent binding changed: %+v", repo)
			}
		})
	}
}
