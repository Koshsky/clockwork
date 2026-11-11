package service

import (
	"github.com/Koshsky/erp-backend/pkg/errors"
	"github.com/Koshsky/erp-backend/pkg/validator"
)

type AssignmentValidator struct {
	validator.Validator
}

func (v *AssignmentValidator) ValidateAssignment(taskID, resourceID int64, quantity int) error {
	if err := v.ValidatePositiveID(taskID, "task_id"); err != nil {
		return err
	}
	if err := v.ValidatePositiveID(resourceID, "resource_id"); err != nil {
		return err
	}
	if quantity < 1 {
		return errors.NewValidationError("quantity must be greater than 0")
	}
	return nil
}
