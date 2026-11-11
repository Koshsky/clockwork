//nolint:testpackage // service-level tests construct AutoCreateService directly with a stub repository (unexported fields)
package service

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"testing"

	"github.com/Koshsky/erp-backend/internal/auto_create/dto"
	tracingpkg "github.com/Koshsky/erp-backend/internal/tracing"
	"github.com/Koshsky/erp-backend/pkg/errors"
)

// fakeRepo is a minimal AutoCreateRepository recording the calls the service
// makes; upserted captures the last config the service persisted.
type fakeRepo struct {
	cfg           *dto.AutoCreateConfig
	resources     map[int64]struct{}
	users         map[int64]struct{}
	failErr       error
	upserted      *dto.AutoCreateConfig
	upsertCalls   int
	resourceCalls int
	userCalls     int
}

func (f *fakeRepo) GetConfig(_ context.Context) (*dto.AutoCreateConfig, error) {
	return f.cfg, f.failErr
}

func (f *fakeRepo) UpsertConfig(_ context.Context, cfg *dto.AutoCreateConfig) error {
	f.upsertCalls++
	f.upserted = cfg
	return f.failErr
}

func (f *fakeRepo) ExistingResources(_ context.Context, _ []int64) (map[int64]struct{}, error) {
	f.resourceCalls++
	return f.resources, f.failErr
}

func (f *fakeRepo) ExistingUsers(_ context.Context, _ []int64) (map[int64]struct{}, error) {
	f.userCalls++
	return f.users, f.failErr
}

// newService builds the service over the fake repository with a discard
// logger and a no-op tracer (same shape as the user service tests).
func newService(r AutoCreateRepository) *AutoCreateService {
	return &AutoCreateService{
		logger:     slog.New(slog.DiscardHandler),
		tracer:     tracingpkg.New(nil),
		repository: r,
	}
}

// configWithOwnerAndResource is a fully valid config: a process owned by user
// 5 with one task binding resource 1 (quantity 2) and one operation.
func configWithOwnerAndResource() *dto.AutoCreateConfig {
	color := "#0f83c4"
	ownerID := int64(5)
	return &dto.AutoCreateConfig{
		Enabled: true,
		Processes: []dto.ProcessTemplate{{
			Title:   "Установка",
			OwnerID: &ownerID,
			Color:   &color,
			Tasks: []dto.TaskTemplate{{
				Title:      "Монтаж",
				Color:      &color,
				Resources:  []dto.ResourceBinding{{ResourceID: 1, Quantity: 2}},
				Operations: []dto.OperationTemplate{{Title: "Подготовка"}},
			}},
		}},
	}
}

// wantValidation asserts err is a validation error mentioning contains.
func wantValidation(t *testing.T, err error, contains string) {
	t.Helper()
	if err == nil {
		t.Fatal("expected a validation error, got nil")
	}
	if !errors.IsValidationError(err) {
		t.Fatalf("error = %v, want a validation error", err)
	}
	if contains != "" && !strings.Contains(err.Error(), contains) {
		t.Fatalf("error = %q, want it to mention %q", err, contains)
	}
}

// TestValidateResourceQuantity checks the quantity rules of a resource
// binding: allowed range is [1, maxQuantityPerAssignment], zero/negative
// values and oversized quantities are rejected; resource ids must be positive.
func TestValidateResourceQuantity(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name       string
		resourceID int64
		quantity   int
		wantErr    bool
		wantMsg    string
	}{
		{"minimum quantity", 1, 1, false, ""},
		{"maximum quantity", 1, 99, false, ""},
		{"zero quantity", 1, 0, true, "должно быть больше 0"},
		{"negative quantity", 1, -3, true, "должно быть больше 0"},
		{"oversized quantity", 1, 100, true, "не должно превышать 99"},
		{"zero resource id", 0, 1, true, "некорректный resource_id"},
		{"negative resource id", -1, 1, true, "некорректный resource_id"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			cfg := &dto.AutoCreateConfig{
				Processes: []dto.ProcessTemplate{{
					Title: "Установка",
					Tasks: []dto.TaskTemplate{{
						Title:     "Монтаж",
						Resources: []dto.ResourceBinding{{ResourceID: tc.resourceID, Quantity: tc.quantity}},
					}},
				}},
			}
			err := validateConfig(cfg)
			if tc.wantErr {
				wantValidation(t, err, tc.wantMsg)
				return
			}
			if err != nil {
				t.Fatalf("validateConfig() = %v, want nil", err)
			}
		})
	}
}

// TestValidateConfigSizeLimits checks the template-size walls guarding the DB
// trigger: too many processes, tasks per process, operations per task,
// resources per task and total assignments are each rejected; the exact
// boundaries pass.
func TestValidateConfigSizeLimits(t *testing.T) {
	t.Parallel()

	build := func(processes, tasks, resources, operations int) *dto.AutoCreateConfig {
		cfg := &dto.AutoCreateConfig{Enabled: true, Processes: make([]dto.ProcessTemplate, 0, processes)}
		for p := 1; p <= processes; p++ {
			proc := dto.ProcessTemplate{
				Title: fmt.Sprintf("процесс %d", p),
				Tasks: make([]dto.TaskTemplate, 0, tasks),
			}
			for ti := 1; ti <= tasks; ti++ {
				task := dto.TaskTemplate{
					Title:      fmt.Sprintf("задача %d", ti),
					Resources:  make([]dto.ResourceBinding, 0, resources),
					Operations: make([]dto.OperationTemplate, 0, operations),
				}
				for ri := 1; ri <= resources; ri++ {
					task.Resources = append(task.Resources, dto.ResourceBinding{ResourceID: int64(ri), Quantity: 1})
				}
				for oi := 1; oi <= operations; oi++ {
					task.Operations = append(
						task.Operations,
						dto.OperationTemplate{Title: fmt.Sprintf("операция %d", oi)},
					)
				}
				proc.Tasks = append(proc.Tasks, task)
			}
			cfg.Processes = append(cfg.Processes, proc)
		}
		return cfg
	}

	cases := []struct {
		name    string
		cfg     *dto.AutoCreateConfig
		wantErr bool
		wantMsg string
	}{
		{"20 processes boundary passes", build(20, 1, 1, 1), false, ""},
		{"21 processes rejected", build(21, 1, 1, 1), true, "слишком много процессов"},
		{"50 tasks per process boundary passes", build(1, 50, 1, 1), false, ""},
		{"51 tasks per process rejected", build(1, 51, 1, 1), true, "слишком много задач"},
		{"50 operations per task boundary passes", build(1, 1, 1, 50), false, ""},
		{"51 operations per task rejected", build(1, 1, 1, 51), true, "слишком много операций"},
		{"10 resources per task boundary passes", build(1, 1, 10, 1), false, ""},
		{"11 resources per task rejected", build(1, 1, 11, 1), true, "слишком много ресурсов"},
		// 2 processes × 30 tasks × 10 resources = 600 assignments > 500 total:
		// per-process limits stay within bounds, so the total cap must fire.
		{"total 500 assignments boundary passes", build(1, 50, 10, 0), false, ""},
		{"total 600 assignments rejected", build(2, 30, 10, 0), true, "слишком много назначений"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			err := validateConfig(tc.cfg)
			if tc.wantErr {
				wantValidation(t, err, tc.wantMsg)
				return
			}
			if err != nil {
				t.Fatalf("validateConfig() = %v, want nil", err)
			}
		})
	}
}

// TestValidateConfigRejectsDuplicateResource checks that binding the same
// resource twice inside one task is rejected.
func TestValidateConfigRejectsDuplicateResource(t *testing.T) {
	t.Parallel()
	cfg := &dto.AutoCreateConfig{
		Processes: []dto.ProcessTemplate{{
			Title: "Установка",
			Tasks: []dto.TaskTemplate{{
				Title: "Монтаж",
				Resources: []dto.ResourceBinding{
					{ResourceID: 1, Quantity: 1},
					{ResourceID: 1, Quantity: 2},
				},
			}},
		}},
	}
	wantValidation(t, validateConfig(cfg), "указан дважды")
}

// TestValidateConfigTitlesAndColors checks the required-title and optional
// #RRGGBB color rules for processes, tasks and operations.
func TestValidateConfigTitlesAndColors(t *testing.T) {
	t.Parallel()

	badColor := "#1234"
	goodColor := "#AABBCC"

	cases := []struct {
		name    string
		mutate  func(cfg *dto.AutoCreateConfig)
		wantMsg string
	}{
		{
			"empty process title",
			func(cfg *dto.AutoCreateConfig) { cfg.Processes[0].Title = "  " },
			"название не заполнено",
		},
		{
			"empty task title",
			func(cfg *dto.AutoCreateConfig) { cfg.Processes[0].Tasks[0].Title = "" },
			"название не заполнено",
		},
		{
			"empty operation title",
			func(cfg *dto.AutoCreateConfig) { cfg.Processes[0].Tasks[0].Operations[0].Title = "" },
			"название не заполнено",
		},
		{
			"malformed process color",
			func(cfg *dto.AutoCreateConfig) { cfg.Processes[0].Color = &badColor },
			"",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			cfg := configWithOwnerAndResource()
			tc.mutate(cfg)
			wantValidation(t, validateConfig(cfg), tc.wantMsg)
		})
	}

	// Positive: nil colors and a valid #RRGGBB color pass.
	cfg := configWithOwnerAndResource()
	cfg.Processes[0].Color = &goodColor
	if err := validateConfig(cfg); err != nil {
		t.Fatalf("validateConfig() with valid color = %v, want nil", err)
	}
}

// TestGetConfigPassthrough checks the service forwards the repository value.
func TestGetConfigPassthrough(t *testing.T) {
	t.Parallel()
	want := configWithOwnerAndResource()
	svc := newService(&fakeRepo{cfg: want})

	got, err := svc.GetConfig(context.Background())
	if err != nil {
		t.Fatalf("GetConfig() error = %v", err)
	}
	if got != want {
		t.Fatalf("GetConfig() = %v, want the repository config", got)
	}
}

// TestSaveConfigHappyPath checks SaveConfig validates, verifies that the
// referenced resource and owner exist, and persists the config.
func TestSaveConfigHappyPath(t *testing.T) {
	t.Parallel()
	repo := &fakeRepo{
		resources: map[int64]struct{}{1: {}},
		users:     map[int64]struct{}{5: {}},
	}
	svc := newService(repo)
	cfg := configWithOwnerAndResource()

	if err := svc.SaveConfig(context.Background(), cfg); err != nil {
		t.Fatalf("SaveConfig() error = %v", err)
	}
	if repo.upsertCalls != 1 {
		t.Errorf("upsert calls = %d, want 1", repo.upsertCalls)
	}
	if repo.upserted != cfg {
		t.Errorf("upserted config = %v, want the saved config", repo.upserted)
	}
}

// TestSaveConfigUnknownReferences checks that a resource or owner missing from
// the DB is rejected before anything is persisted.
func TestSaveConfigUnknownReferences(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name      string
		resources map[int64]struct{}
		users     map[int64]struct{}
		wantMsg   string
	}{
		{
			"missing resource",
			map[int64]struct{}{},
			map[int64]struct{}{5: {}},
			"ресурс 1 не найден",
		},
		{
			"missing owner",
			map[int64]struct{}{1: {}},
			map[int64]struct{}{},
			"владелец процесса 5 не найден",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			repo := &fakeRepo{resources: tc.resources, users: tc.users}
			svc := newService(repo)

			err := svc.SaveConfig(context.Background(), configWithOwnerAndResource())
			wantValidation(t, err, tc.wantMsg)
			if repo.upsertCalls != 0 {
				t.Errorf("upsert calls = %d, want 0 (nothing persisted)", repo.upsertCalls)
			}
		})
	}
}

// TestSaveConfigRejectsInvalidBeforeRepo checks the validation short-circuit:
// an invalid quantity must fail without any repository call.
func TestSaveConfigRejectsInvalidBeforeRepo(t *testing.T) {
	t.Parallel()
	repo := &fakeRepo{resources: map[int64]struct{}{1: {}}}
	svc := newService(repo)

	cfg := configWithOwnerAndResource()
	cfg.Processes[0].Tasks[0].Resources[0].Quantity = 0

	err := svc.SaveConfig(context.Background(), cfg)
	wantValidation(t, err, "должно быть больше 0")
	if repo.resourceCalls != 0 || repo.userCalls != 0 || repo.upsertCalls != 0 {
		t.Errorf("repo calls = resource:%d user:%d upsert:%d, want no repository interaction",
			repo.resourceCalls, repo.userCalls, repo.upsertCalls)
	}
}

// TestCollectResourceIDs checks the deduping collector used for the existence
// check: ids are unique and gathered across processes and tasks.
func TestCollectResourceIDs(t *testing.T) {
	t.Parallel()
	cfg := configWithOwnerAndResource()
	cfg.Processes[0].Tasks = append(cfg.Processes[0].Tasks,
		dto.TaskTemplate{
			Title: "Пуско-наладка",
			Resources: []dto.ResourceBinding{
				{ResourceID: 1, Quantity: 1}, // duplicate of the first task's id
				{ResourceID: 9, Quantity: 1},
			},
		},
	)
	cfg.Processes = append(cfg.Processes, dto.ProcessTemplate{
		Title: "Второй процесс",
		Tasks: []dto.TaskTemplate{{
			Title:     "Задача",
			Resources: []dto.ResourceBinding{{ResourceID: 3, Quantity: 1}},
		}},
	})

	got := collectResourceIDs(cfg)
	if len(got) != 3 || got[0] != 1 || got[1] != 9 || got[2] != 3 {
		t.Errorf("collectResourceIDs() = %v, want [1 9 3] (deduped, process order)", got)
	}
}

// TestCollectOwnerIDs checks that only non-nil owner ids are collected and
// duplicates across processes collapse into one.
func TestCollectOwnerIDs(t *testing.T) {
	t.Parallel()
	cfg := configWithOwnerAndResource()
	dupOwner := int64(5)
	otherOwner := int64(7)
	cfg.Processes = append(cfg.Processes,
		dto.ProcessTemplate{Title: "Без владельца"},                // nil owner: skipped
		dto.ProcessTemplate{Title: "Дубликат", OwnerID: &dupOwner}, // duplicate owner: skipped
		dto.ProcessTemplate{Title: "Другой", OwnerID: &otherOwner},
	)

	got := collectOwnerIDs(cfg)
	if len(got) != 2 || got[0] != 5 || got[1] != 7 {
		t.Errorf("collectOwnerIDs() = %v, want [5 7]", got)
	}
}
