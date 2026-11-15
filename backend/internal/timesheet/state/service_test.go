package state_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"reflect"
	"strings"
	"testing"

	state "github.com/Koshsky/erp-backend/internal/timesheet/state"
	"github.com/Koshsky/erp-backend/internal/timesheet/state/dto"
	"github.com/Koshsky/erp-backend/internal/timesheet/state/repository/sqlc"
	"github.com/Koshsky/erp-backend/internal/tracing"
	errorsapi "github.com/Koshsky/erp-backend/pkg/errors"
)

type stateRepository struct {
	row                *sqlc.State
	rows               []sqlc.State
	foundErr, writeErr error
	listErr            error
	reads, writes      int
}

func stateFixture() sqlc.State {
	return sqlc.State{ID: 3, Code: "WORK", Name: "Work day", IsAvailable: true,
		Color: sql.NullString{String: "#abcdef", Valid: true}}
}

func newStateService(repo *stateRepository) *state.Service {
	return state.NewService(slog.New(slog.DiscardHandler), tracing.New(nil), repo)
}

func (r *stateRepository) CreateState(
	_ context.Context,
	code, name string,
	available bool,
	color *string,
) (*sqlc.State, error) {
	r.writes++
	row := sqlc.State{ID: 3, Code: code, Name: name, IsAvailable: available}
	if color != nil {
		row.Color = sql.NullString{String: *color, Valid: true}
	}
	r.row = &row
	return r.row, r.writeErr
}

func (r *stateRepository) FindState(context.Context, int64) (*sqlc.State, error) {
	r.reads++
	if r.row == nil {
		return nil, r.foundErr
	}
	row := *r.row
	return &row, r.foundErr
}

func (r *stateRepository) UpdateState(_ context.Context, row sqlc.State) (*sqlc.State, error) {
	r.writes++
	r.row = &row
	return r.row, r.writeErr
}

func (r *stateRepository) DeleteState(context.Context, int64) error {
	r.writes++
	return r.writeErr
}

func (r *stateRepository) ListStates(context.Context) ([]sqlc.State, error) { return r.rows, r.listErr }

func TestStateCRUDPreservesAvailabilityDefault(t *testing.T) {
	t.Parallel()
	for _, body := range []string{`{"code":"OFF","name":"Leave"}`, `{"code":"ON","name":"Work","is_available":true,"color":"#123456"}`} {
		var req dto.CreateStateRequest
		if err := json.Unmarshal([]byte(body), &req); err != nil {
			t.Fatal(err)
		}
		repo := &stateRepository{}
		svc := newStateService(repo)
		created, err := svc.CreateState(t.Context(), req)
		if err != nil || repo.writes != 1 || created.ID != 3 || created.Code != req.Code ||
			created.Name != req.Name || created.IsAvailable != req.IsAvailable || !reflect.DeepEqual(created.Color, req.Color) {
			t.Fatalf("create changed catalog values: %+v, %v", created, err)
		}
		found, err := svc.FindState(t.Context(), 3)
		if err != nil || !reflect.DeepEqual(found, created) {
			t.Fatalf("find changed catalog values: %+v, %v", found, err)
		}
		if err = svc.DeleteState(t.Context(), 3); err != nil || repo.writes != 2 {
			t.Fatalf("delete did not reach the repository: %v", err)
		}
	}
}

func TestStateValidationBeforeWrites(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct{ name, code, label, color, field string }{
		{"empty code", " \t", "Name", "#123456", "code"},
		{"empty name", "CODE", "\n", "#123456", "name"},
		{"invalid color", "CODE", "Name", "red", "color"},
		{"short color", "CODE", "Name", "#fff", "color"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			row := stateFixture()
			repo := &stateRepository{row: &row}
			svc := newStateService(repo)
			_, createErr := svc.CreateState(
				t.Context(),
				dto.CreateStateRequest{Code: tc.code, Name: tc.label, Color: &tc.color},
			)
			_, updateErr := svc.UpdateState(
				t.Context(),
				3,
				dto.UpdateStateRequest{Code: &tc.code, Name: &tc.label, Color: &tc.color},
			)
			for _, err := range []error{createErr, updateErr} {
				var field *errorsapi.FieldError
				if !errors.As(err, &field) || field.Field != tc.field || !errors.Is(err, errorsapi.ErrValidation) {
					t.Fatalf("validation field changed: %v", err)
				}
			}
			if repo.writes != 0 || *repo.row != stateFixture() {
				t.Fatal("invalid write mutated the stored state")
			}
		})
	}
}

func TestStatePatchAvailabilityAndColor(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, body string
		initial    bool
		change     func(*sqlc.State)
	}{
		{"absent", `{}`, true, func(*sqlc.State) {}},
		{"null", `{"code":null,"name":null,"is_available":null,"color":null}`, true, func(*sqlc.State) {}},
		{"disable", `{"is_available":false}`, true, func(r *sqlc.State) { r.IsAvailable = false }},
		{"enable", `{"is_available":true}`, false, func(r *sqlc.State) { r.IsAvailable = true }},
		{"clear color", `{"color":""}`, true, func(r *sqlc.State) { r.Color = sql.NullString{} }},
		{"replace", `{"code":"OFF","name":"Leave","is_available":false,"color":"#123456"}`, true,
			func(r *sqlc.State) {
				r.Code, r.Name, r.IsAvailable = "OFF", "Leave", false
				r.Color = sql.NullString{String: "#123456", Valid: true}
			}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			row := stateFixture()
			row.IsAvailable = tc.initial
			want := row
			tc.change(&want)
			repo := &stateRepository{row: &row}
			var req dto.UpdateStateRequest
			if err := json.Unmarshal([]byte(tc.body), &req); err != nil {
				t.Fatal(err)
			}
			response, err := newStateService(repo).UpdateState(t.Context(), 3, req)
			if err != nil || *repo.row != want || repo.writes != 1 || response.IsAvailable != want.IsAvailable {
				t.Fatalf("patch semantics changed: %+v, %v", repo.row, err)
			}
		})
	}
}

func TestStateMapperPreservesUnavailableFlag(t *testing.T) {
	t.Parallel()
	mapper := state.NewMapper()
	if mapper.ToDTO(nil) != nil || mapper.ToDTOs(nil) == nil || len(mapper.ToDTOs(nil)) != 0 {
		t.Fatal("nil/empty mapping changed")
	}
	for _, color := range []sql.NullString{{String: "ignored"}, {Valid: true}, {String: "#123456", Valid: true}} {
		row := stateFixture()
		row.IsAvailable, row.Color = false, color
		response := mapper.ToDTO(&row)
		wantColor := (*string)(nil)
		if color.Valid && color.String != "" {
			wantColor = &color.String
		}
		want := dto.StateResponse{ID: 3, Code: "WORK", Name: "Work day", IsAvailable: false, Color: wantColor}
		if !reflect.DeepEqual(*response, want) {
			t.Fatalf("state mapping changed: %+v", response)
		}
		raw, err := json.Marshal(response)
		if err != nil || !strings.Contains(string(raw), `"is_available":false`) {
			t.Fatal("unavailable flag omitted from JSON")
		}
	}
}

func TestStateListPreservesOrderAndEmpty(t *testing.T) {
	t.Parallel()
	for _, rows := range [][]sqlc.State{nil, {}, {{ID: 9, IsAvailable: false}, {ID: 2, IsAvailable: true}}} {
		items, err := newStateService(&stateRepository{rows: rows}).ListStates(t.Context())
		if err != nil || items == nil || len(items) != len(rows) {
			t.Fatalf("empty list changed: %+v, %v", items, err)
		}
		for i, row := range rows {
			if items[i].ID != row.ID || items[i].IsAvailable != row.IsAvailable {
				t.Fatal("list changed order or availability")
			}
		}
	}
}

func stateOperation(t *testing.T, svc *state.Service, operation string) error {
	t.Helper()
	switch operation {
	case "create":
		_, err := svc.CreateState(t.Context(), dto.CreateStateRequest{Code: "CODE", Name: "Name"})
		return err
	case "find":
		_, err := svc.FindState(t.Context(), 3)
		return err
	case "update":
		_, err := svc.UpdateState(t.Context(), 3, dto.UpdateStateRequest{})
		return err
	case "delete":
		return svc.DeleteState(t.Context(), 3)
	default:
		_, err := svc.ListStates(t.Context())
		return err
	}
}

func TestStateRepositoryFailures(t *testing.T) {
	t.Parallel()
	failure := errors.New("database unavailable")
	conflict := errorsapi.Conflict("state with this code already exists")
	for _, tc := range []struct {
		name, operation string
		repo            stateRepository
		want            error
	}{
		{"create conflict", "create", stateRepository{writeErr: conflict}, conflict},
		{"find error", "find", stateRepository{foundErr: failure}, failure},
		{"find missing", "find", stateRepository{foundErr: errorsapi.ErrNotFound}, errorsapi.ErrStateNotFound},
		{"find nil", "find", stateRepository{}, errorsapi.ErrStateNotFound},
		{"update fetch error", "update", stateRepository{foundErr: failure}, errorsapi.ErrStateNotFound},
		{"update write", "update", stateRepository{row: new(stateFixture()), writeErr: failure}, failure},
		{"delete missing", "delete", stateRepository{foundErr: errorsapi.ErrNotFound}, nil},
		{"delete nil", "delete", stateRepository{}, nil},
		{"delete fetch error", "delete", stateRepository{foundErr: failure}, failure},
		{"delete write", "delete", stateRepository{row: new(stateFixture()), writeErr: failure}, failure},
		{"list", "list", stateRepository{listErr: failure}, failure},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if err := stateOperation(t, newStateService(&tc.repo), tc.operation); !errors.Is(err, tc.want) {
				t.Fatalf("repository error classification changed: %v, want %v", err, tc.want)
			}
			if tc.want == nil && tc.repo.writes != 0 {
				t.Fatal("idempotent missing delete issued a write")
			}
		})
	}
}
