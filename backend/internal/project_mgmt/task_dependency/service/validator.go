package service

import (
	"github.com/Koshsky/erp-backend/internal/project_mgmt/task_dependency/domain"
	"github.com/Koshsky/erp-backend/pkg/errors"
	"github.com/Koshsky/erp-backend/pkg/messages"
	"github.com/Koshsky/erp-backend/pkg/validator"
)

type DependencyValidator struct {
	validator.Validator
}

// ValidateType rejects a value outside the dependency type catalog.
func (v *DependencyValidator) ValidateType(typ string) error {
	if !domain.ValidType(typ) {
		return errors.NewFieldErrorM("type", "invalid_value", messages.M("task_dependency.unknown_type", typ))
	}
	return nil
}

// ValidateCreate validates the ids of a new dependency edge.
func (v *DependencyValidator) ValidateCreate(taskID, dependsOnTaskID int64, typ string) error {
	if err := v.ValidatePositiveID(taskID, "task_id"); err != nil {
		return err
	}
	if err := v.ValidatePositiveID(dependsOnTaskID, "depends_on_task_id"); err != nil {
		return err
	}
	return v.ValidateType(typ)
}

// ValidateTypeUpdate validates the type of an update request.
func (v *DependencyValidator) ValidateTypeUpdate(typ string) error {
	return v.ValidateType(typ)
}
