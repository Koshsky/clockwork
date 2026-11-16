package service_test

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Koshsky/erp-backend/internal/auto_create/dto"
	"github.com/Koshsky/erp-backend/internal/auto_create/repository"
	"github.com/Koshsky/erp-backend/internal/auto_create/repository/sqlc"
	"github.com/Koshsky/erp-backend/internal/auto_create/service"
	"github.com/Koshsky/erp-backend/internal/database"
	"github.com/Koshsky/erp-backend/internal/tracing"
	errorsapi "github.com/Koshsky/erp-backend/pkg/errors"
)

type templateRow struct {
	values []any
	err    error
}

func (r templateRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	for i, value := range r.values {
		reflect.ValueOf(dest[i]).Elem().Set(reflect.ValueOf(value))
	}
	return nil
}

type templateRows struct {
	pgx.Rows

	ids   []int64
	index int
}

func (r *templateRows) Next() bool { r.index++; return r.index <= len(r.ids) }
func (r *templateRows) Close()     {}
func (r *templateRows) Err() error { return nil }
func (r *templateRows) Scan(dest ...any) error {
	*dest[0].(*int64) = r.ids[r.index-1]
	return nil
}

type templateQuery struct {
	name string
	args []any
}

type templateTransaction struct {
	pgx.Tx

	ctx       context.Context
	raw       json.RawMessage
	enabled   bool
	readErr   error
	failAt    string
	failure   error
	resources []int64
	owners    []int64
	calls     []templateQuery
	finalized bool
}

func (tx *templateTransaction) QueryRow(ctx context.Context, query string, args ...any) pgx.Row {
	if active, ok := database.TxFrom(ctx); !ok || active != tx || tracing.RequestIDFrom(ctx) != "b18-request" {
		return templateRow{err: errors.New("request context lost")}
	}
	if strings.Contains(query, "UpsertAutoCreateConfig") {
		tx.calls = append(tx.calls, templateQuery{"save", args})
		if tx.failAt == "save" {
			return templateRow{err: tx.failure}
		}
		tx.enabled, tx.raw = args[0].(bool), args[1].(json.RawMessage)
		return templateRow{values: []any{int64(1), tx.enabled, tx.raw, time.Time{}, time.Time{}}}
	}
	tx.calls = append(tx.calls, templateQuery{"read", args})
	return templateRow{values: []any{int64(1), tx.enabled, tx.raw}, err: tx.readErr}
}

func (tx *templateTransaction) Query(ctx context.Context, query string, args ...any) (pgx.Rows, error) {
	if active, ok := database.TxFrom(ctx); !ok || active != tx || tracing.RequestIDFrom(ctx) != "b18-request" {
		return nil, errors.New("request context lost")
	}
	name, ids := "resources", tx.resources
	if strings.Contains(query, "ListExistingUsers") {
		name, ids = "owners", tx.owners
	}
	tx.calls = append(tx.calls, templateQuery{name, args})
	if tx.failAt == name {
		return nil, tx.failure
	}
	return &templateRows{ids: ids}, nil
}

func (tx *templateTransaction) Commit(context.Context) error   { tx.finalized = true; return nil }
func (tx *templateTransaction) Rollback(context.Context) error { tx.finalized = true; return nil }

func templateService(t *testing.T, tx *templateTransaction) *service.AutoCreateService {
	t.Helper()
	tx.ctx = database.WithTx(tracing.WithRequestID(t.Context(), "b18-request"), tx)
	logger := slog.New(slog.DiscardHandler)
	return service.NewAutoCreateService(logger, tracing.New(nil), repository.NewAutoCreateRepository(logger, nil))
}

func assertTemplateJSON(t *testing.T, got any, want string) {
	t.Helper()
	raw, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	var actual, expected any
	if err = json.Unmarshal(raw, &actual); err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal([]byte(want), &expected); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(actual, expected) {
		t.Fatalf("template JSON changed: got=%s want=%s", raw, want)
	}
}

func TestConfigReadJSONCompatibility(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, raw, want string
		enabled         bool
		readErr         error
		invalid         bool
	}{
		{"unset", "", `{"enabled":false,"processes":[]}`, false, pgx.ErrNoRows, false},
		{"wrapped missing row", "", `{"enabled":false,"processes":[]}`, false, errors.Join(errors.New("lookup"), pgx.ErrNoRows), false},
		{"disabled null", "null", `{"enabled":false,"processes":[]}`, false, nil, false},
		{"enabled null", "null", `{"enabled":true,"processes":[]}`, true, nil, false},
		{"empty array", "[]", `{"enabled":true,"processes":[]}`, true, nil, false},
		{"nested nulls", `[{"title":"Процесс <raw>","unknown":"ignored"}]`, `{"enabled":true,"processes":[{"title":"Процесс <raw>","owner_id":null,"color":null,"tasks":null}]}`, true, nil, false},
		{"nested empty arrays", `[{"title":"P","tasks":[{"title":"T","resources":[],"operations":[]}]}]`, `{"enabled":true,"processes":[{"title":"P","owner_id":null,"color":null,"tasks":[{"title":"T","color":null,"resources":[],"operations":[]}]}]}`, true, nil, false},
		{"empty stored bytes", "", "", false, nil, true},
		{"malformed JSON", "[", "", true, nil, true},
		{"object instead of array", "{}", "", true, nil, true},
		{"disabled malformed config", "[", "", false, nil, true},
		{"invalid owner type", `[{"title":"P","owner_id":"7"}]`, "", true, nil, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			tx := &templateTransaction{raw: json.RawMessage(tc.raw), enabled: tc.enabled, readErr: tc.readErr}
			got, err := templateService(t, tx).GetConfig(tx.ctx)
			if tc.invalid {
				if err == nil || got != nil {
					t.Fatalf("invalid stored config accepted: %+v, %v", got, err)
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				assertTemplateJSON(t, got, tc.want)
			}
			if tx.finalized || len(tx.calls) != 1 || tx.calls[0].name != "read" {
				t.Fatalf("read escaped request transaction: %+v", tx.calls)
			}
		})
	}
}

func TestConfigSaveAndReloadPreservesTemplateJSON(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct{ name, body, stored, loaded string }{
		{"missing processes", `{"enabled":false}`, "null", `{"enabled":false,"processes":[]}`},
		{"explicit empty array", `{"enabled":false,"processes":[]}`, "[]", `{"enabled":false,"processes":[]}`},
		{"inherited owner and nested null", `{"enabled":true,"processes":[{"title":"P"}]}`, `[{"title":"P","owner_id":null,"color":null,"tasks":null}]`, `{"enabled":true,"processes":[{"title":"P","owner_id":null,"color":null,"tasks":null}]}`},
		{"explicit empty tasks", `{"enabled":true,"processes":[{"title":"P","tasks":[]}]}`, `[{"title":"P","owner_id":null,"color":null,"tasks":[]}]`, `{"enabled":true,"processes":[{"title":"P","owner_id":null,"color":null,"tasks":[]}]}`},
		{"complete template", `{"enabled":true,"processes":[{"title":"Процесс <one>","owner_id":7,"color":"#ABCDEF","tasks":[{"title":"Задача","color":"#123456","resources":[{"resource_id":11,"quantity":2}],"operations":[{"title":"Операция"},{"title":"Вторая"}]}]}]}`, `[{"title":"Процесс <one>","owner_id":7,"color":"#ABCDEF","tasks":[{"title":"Задача","color":"#123456","resources":[{"resource_id":11,"quantity":2}],"operations":[{"title":"Операция"},{"title":"Вторая"}]}]}]`, `{"enabled":true,"processes":[{"title":"Процесс <one>","owner_id":7,"color":"#ABCDEF","tasks":[{"title":"Задача","color":"#123456","resources":[{"resource_id":11,"quantity":2}],"operations":[{"title":"Операция"},{"title":"Вторая"}]}]}]}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			var cfg dto.AutoCreateConfig
			if err := json.Unmarshal([]byte(tc.body), &cfg); err != nil {
				t.Fatal(err)
			}
			original, err := json.Marshal(&cfg)
			if err != nil {
				t.Fatal(err)
			}
			tx := &templateTransaction{resources: []int64{11}, owners: []int64{7}}
			svc := templateService(t, tx)
			if err = svc.SaveConfig(tx.ctx, &cfg); err != nil {
				t.Fatal(err)
			}
			assertTemplateJSON(t, tx.raw, tc.stored)
			assertTemplateJSON(t, &cfg, string(original))
			got, err := svc.GetConfig(tx.ctx)
			if err != nil {
				t.Fatal(err)
			}
			assertTemplateJSON(t, got, tc.loaded)
			if tx.finalized || tx.enabled != cfg.Enabled {
				t.Fatal("save finalized request transaction or changed enabled flag")
			}
		})
	}
}

func TestConfigSaveFailuresStopBeforeSubsequentQueries(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, failAt string
		invalid      bool
		wantCalls    []string
	}{
		{"resource lookup", "resources", false, []string{"resources"}},
		{"owner lookup", "owners", false, []string{"resources", "owners"}},
		{"persistence", "save", false, []string{"resources", "owners", "save"}},
		{"disabled still validates", "", true, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			failure := errors.New("template repository failed")
			tx := &templateTransaction{
				resources: []int64{11}, owners: []int64{7}, failAt: tc.failAt, failure: failure,
			}
			cfg := &dto.AutoCreateConfig{Processes: []dto.ProcessTemplate{{
				Title: "P", OwnerID: new(int64(7)), Tasks: []dto.TaskTemplate{{
					Title: "T", Resources: []dto.ResourceBinding{{ResourceID: 11, Quantity: 1}},
				}},
			}}}
			if tc.invalid {
				cfg.Processes[0].Tasks[0].Resources[0].Quantity = 0
			}
			err := templateService(t, tx).SaveConfig(tx.ctx, cfg)
			if (tc.invalid && !errorsapi.IsValidationError(err)) || (!tc.invalid && !errors.Is(err, failure)) {
				t.Fatalf("save error classification changed: %v", err)
			}
			var calls []string
			for _, call := range tx.calls {
				calls = append(calls, call.name)
			}
			if !reflect.DeepEqual(calls, tc.wantCalls) || tx.finalized {
				t.Fatalf("failed save changed query/transaction ordering: %v", calls)
			}
		})
	}
}

func TestConfigOwnerSemanticsAndReferenceDeduplication(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name  string
		owner *int64
		valid bool
	}{
		{"unspecified owner", nil, true},
		{"explicit existing owner", new(int64(7)), true},
		{"zero owner is checked", new(int64(0)), false},
		{"negative owner is checked", new(int64(-1)), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			cfg := &dto.AutoCreateConfig{Enabled: true, Processes: []dto.ProcessTemplate{
				{Title: "P1", OwnerID: tc.owner, Tasks: []dto.TaskTemplate{
					{
						Title:     "T1",
						Resources: []dto.ResourceBinding{{ResourceID: 11, Quantity: 1}, {ResourceID: 12, Quantity: 2}},
					},
					{Title: "T2", Resources: []dto.ResourceBinding{{ResourceID: 11, Quantity: 3}}},
				}},
				{Title: "P2", OwnerID: tc.owner},
			}}
			tx := &templateTransaction{resources: []int64{11, 12}, owners: []int64{7}}
			err := templateService(t, tx).SaveConfig(tx.ctx, cfg)
			if tc.valid && err != nil {
				t.Fatal(err)
			}
			if !tc.valid && !errorsapi.IsValidationError(err) {
				t.Fatalf("missing explicit owner not rejected: %v", err)
			}
			checkTemplateReferenceCalls(t, tx, tc.owner, tc.valid)
		})
	}
}

func checkTemplateReferenceCalls(t *testing.T, tx *templateTransaction, owner *int64, valid bool) {
	t.Helper()
	want := []templateQuery{{"resources", []any{[]int64{11, 12}}}}
	if owner != nil {
		want = append(want, templateQuery{"owners", []any{[]int64{*owner}}})
	}
	lookups := tx.calls
	if valid {
		last := tx.calls[len(tx.calls)-1]
		if last.name != "save" {
			t.Fatal("valid config not persisted")
		}
		lookups = lookups[:len(lookups)-1]
	}
	if !reflect.DeepEqual(lookups, want) || tx.finalized {
		t.Fatalf("owner/resource lookup semantics changed: %+v", tx.calls)
	}
}

func TestConfigSQLAdapterDoesNotInterpretJSON(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, raw string
		err       error
	}{
		{"array", "[]", nil},
		{"null", "null", nil},
		{"object shape", "{}", nil},
		{"unknown fields and whitespace", "[ {\"unknown\": true} ]", nil},
		{"missing row", "", pgx.ErrNoRows},
		{"read failure", "", errors.New("config read failed")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			tx := &templateTransaction{raw: json.RawMessage(tc.raw), enabled: true, readErr: tc.err}
			tx.ctx = database.WithTx(tracing.WithRequestID(t.Context(), "b18-request"), tx)
			repo := repository.NewAutoCreateRepository(slog.New(slog.DiscardHandler), nil)
			row, err := repo.GetConfig(tx.ctx)
			if !errors.Is(err, tc.err) {
				t.Fatal(err)
			}
			if tc.err != nil {
				if row != nil {
					t.Fatal("failed lookup returned a row")
				}
				return
			}
			if row == nil || row.ID != 1 || !row.Enabled || string(row.Config) != tc.raw {
				t.Fatalf("repository interpreted stored config: %+v", row)
			}
			checkRawConfigWrite(t, tx, repo, tc.raw)
		})
	}
}

func checkRawConfigWrite(t *testing.T, tx *templateTransaction, repo *repository.AutoCreateRepository, raw string) {
	t.Helper()
	params := sqlc.UpsertAutoCreateConfigParams{Enabled: false, Config: json.RawMessage(raw)}
	if err := repo.UpsertConfig(tx.ctx, params); err != nil {
		t.Fatal(err)
	}
	if tx.enabled || string(tx.raw) != raw || tx.finalized || len(tx.calls) != 2 ||
		!reflect.DeepEqual(tx.calls[1].args, []any{false, params.Config}) {
		t.Fatalf("repository changed raw write or finalized request transaction: %+v", tx.calls)
	}
}
