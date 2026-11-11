package service

import (
	"context"
	"fmt"
	"log/slog"
	"strings"

	repo "github.com/Koshsky/erp-backend/internal/auto_create/repository"
	tracingpkg "github.com/Koshsky/erp-backend/internal/tracing"

	"github.com/Koshsky/erp-backend/internal/auto_create/dto"
	"github.com/Koshsky/erp-backend/pkg/errors"
	"github.com/Koshsky/erp-backend/pkg/messages"
	"github.com/Koshsky/erp-backend/pkg/validator"
)

type AutoCreateService struct {
	logger     *slog.Logger
	tracer     *tracingpkg.Tracer
	repository AutoCreateRepository
}

// NewAutoCreateService builds the AutoCreateService service.
func NewAutoCreateService(
	logger *slog.Logger,
	tracer *tracingpkg.Tracer,
	r *repo.AutoCreateRepository,
) *AutoCreateService {
	return &AutoCreateService{
		logger:     logger.With("component", "auto_create_service"),
		tracer:     tracer,
		repository: r,
	}
}

// GetConfig returns the current auto-create config (disabled+empty if unset).
func (s *AutoCreateService) GetConfig(ctx context.Context) (*dto.AutoCreateConfig, error) {
	ctx, end := s.tracer.Start(ctx, "autocreate.GetConfig")
	defer end(nil)

	return s.repository.GetConfig(ctx)
}

// SaveConfig replaces the auto-create config; validates shape and that all
// referenced owners/resources exist (otherwise the auto-created project would fail on an FK).
func (s *AutoCreateService) SaveConfig(ctx context.Context, cfg *dto.AutoCreateConfig) error {
	ctx, end := s.tracer.Start(ctx, "autocreate.SaveConfig")
	defer end(nil)

	if err := validateConfig(cfg); err != nil {
		return err
	}

	if resourceIDs := collectResourceIDs(cfg); len(resourceIDs) > 0 {
		existing, err := s.repository.ExistingResources(ctx, resourceIDs)
		if err != nil {
			return err
		}
		for _, id := range resourceIDs {
			if _, ok := existing[id]; !ok {
				return errors.NewValidationErrorM(messages.M("auto_create.resource_not_found", id))
			}
		}
	}

	if ownerIDs := collectOwnerIDs(cfg); len(ownerIDs) > 0 {
		existing, err := s.repository.ExistingUsers(ctx, ownerIDs)
		if err != nil {
			return err
		}
		for _, id := range ownerIDs {
			if _, ok := existing[id]; !ok {
				return errors.NewValidationErrorM(messages.M("auto_create.process_owner_not_found", id))
			}
		}
	}

	return s.repository.UpsertConfig(ctx, cfg)
}

// Limits protecting project creation from a pathological template: the DB
// trigger (V8) applies the whole template atomically inside the project INSERT
// transaction, so an unbounded template is a self-inflicted DoS on every new
// project. The frontend mirrors these limits in its own validation.
const (
	maxProcesses             = 20
	maxTasksPerProcess       = 50
	maxOperationsPerTask     = 50
	maxResourcesPerTask      = 10
	maxAssignmentsTotal      = 500
	maxQuantityPerAssignment = 99
)

func validateConfig(cfg *dto.AutoCreateConfig) error {
	if len(cfg.Processes) > maxProcesses {
		return errors.NewValidationErrorM(messages.M("auto_create.too_many_processes", maxProcesses))
	}
	totalAssignments := 0
	for pi, p := range cfg.Processes {
		if len(p.Tasks) > maxTasksPerProcess {
			return errors.NewValidationErrorM(
				messages.M("auto_create.process_too_many_tasks", pi+1, maxTasksPerProcess),
			)
		}
		if err := validateProcess(p, pi); err != nil {
			return err
		}
		for _, t := range p.Tasks {
			totalAssignments += len(t.Resources)
		}
	}
	if totalAssignments > maxAssignmentsTotal {
		return errors.NewValidationErrorM(messages.M("auto_create.too_many_assignments", maxAssignmentsTotal))
	}
	return nil
}

func validateProcess(p dto.ProcessTemplate, pi int) error {
	if strings.TrimSpace(p.Title) == "" {
		return errors.NewValidationErrorM(messages.M("auto_create.process_title_missing", pi+1))
	}
	if err := validateTemplateColor(p.Color, fmt.Sprintf("процесс %d", pi+1)); err != nil {
		return err
	}
	for ti, t := range p.Tasks {
		if err := validateTask(p.Title, t, ti); err != nil {
			return err
		}
	}
	return nil
}

// validateTemplateColor validates an optional #RRGGBB color of a template
// entry (process/task); the prefix names the entry in the user-facing message.
func validateTemplateColor(color *string, prefix string) error {
	v := &validator.Validator{}
	if err := v.ValidateOptionalColor(color, "color"); err != nil {
		return errors.NewValidationError(fmt.Sprintf("%s: %s", prefix, err.Error()))
	}
	return nil
}

func validateTask(processTitle string, t dto.TaskTemplate, ti int) error {
	if strings.TrimSpace(t.Title) == "" {
		return errors.NewValidationErrorM(
			messages.M("auto_create.process_task_title_missing", processTitle, ti+1),
		)
	}
	if err := validateTemplateColor(t.Color, fmt.Sprintf("процесс «%s», задача %d", processTitle, ti+1)); err != nil {
		return err
	}
	if len(t.Operations) > maxOperationsPerTask {
		return errors.NewValidationErrorM(
			messages.M("auto_create.process_task_too_many_operations", processTitle, ti+1, maxOperationsPerTask),
		)
	}
	for oi, op := range t.Operations {
		if err := validateOperation(processTitle, t.Title, op, oi); err != nil {
			return err
		}
	}
	if len(t.Resources) > maxResourcesPerTask {
		return errors.NewValidationErrorM(
			messages.M("auto_create.process_task_too_many_resources", processTitle, ti+1, maxResourcesPerTask),
		)
	}
	seen := make(map[int64]struct{}, len(t.Resources))
	for ri, res := range t.Resources {
		if err := validateResource(t.Title, res, ri, seen); err != nil {
			return err
		}
	}
	return nil
}

func validateOperation(processTitle, taskTitle string, op dto.OperationTemplate, oi int) error {
	if strings.TrimSpace(op.Title) == "" {
		return errors.NewValidationErrorM(
			messages.M("auto_create.task_operation_title_missing", processTitle, taskTitle, oi+1),
		)
	}
	return nil
}

func validateResource(taskTitle string, res dto.ResourceBinding, ri int, seen map[int64]struct{}) error {
	if res.ResourceID <= 0 {
		return errors.NewValidationErrorM(
			messages.M("auto_create.task_resource_invalid_id", taskTitle, ri+1),
		)
	}
	if res.Quantity <= 0 {
		return errors.NewValidationErrorM(
			messages.M("auto_create.task_resource_quantity_positive", taskTitle, ri+1),
		)
	}
	if res.Quantity > maxQuantityPerAssignment {
		return errors.NewValidationErrorM(
			messages.M("auto_create.task_resource_quantity_max", taskTitle, ri+1, maxQuantityPerAssignment),
		)
	}
	if _, dup := seen[res.ResourceID]; dup {
		return errors.NewValidationErrorM(
			messages.M("auto_create.task_resource_duplicate", taskTitle, res.ResourceID),
		)
	}
	seen[res.ResourceID] = struct{}{}
	return nil
}

func collectResourceIDs(cfg *dto.AutoCreateConfig) []int64 {
	seen := make(map[int64]struct{})
	var out []int64
	for _, p := range cfg.Processes {
		for _, t := range p.Tasks {
			for _, res := range t.Resources {
				if _, ok := seen[res.ResourceID]; !ok {
					seen[res.ResourceID] = struct{}{}
					out = append(out, res.ResourceID)
				}
			}
		}
	}
	return out
}

func collectOwnerIDs(cfg *dto.AutoCreateConfig) []int64 {
	seen := make(map[int64]struct{})
	var out []int64
	for _, p := range cfg.Processes {
		if p.OwnerID != nil {
			if _, ok := seen[*p.OwnerID]; !ok {
				seen[*p.OwnerID] = struct{}{}
				out = append(out, *p.OwnerID)
			}
		}
	}
	return out
}
