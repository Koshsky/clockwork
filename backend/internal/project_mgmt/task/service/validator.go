package service

import (
	"github.com/Koshsky/erp-backend/internal/project_mgmt/task/domain"
	"github.com/Koshsky/erp-backend/pkg/date"
	"github.com/Koshsky/erp-backend/pkg/errors"
	"github.com/Koshsky/erp-backend/pkg/validator"
)

type TaskValidator struct {
	validator.Validator
}

func (v *TaskValidator) ValidateTask(
	processID int64,
	title string,
	color *string,
	status string,
	parentID *int64,
	startDate, endDate date.Date,
) error {
	if err := v.ValidatePositiveID(processID, "process_id"); err != nil {
		return err
	}
	if err := v.ValidateRequiredText(title, "title"); err != nil {
		return err
	}
	if err := v.ValidateOptionalColor(color, "color"); err != nil {
		return err
	}
	if err := v.validateStatus(status); err != nil {
		return err
	}
	if err := v.ValidateOptionalPositiveID(parentID, "parent_id"); err != nil {
		return err
	}
	// Subtasks inherit the parent's dates, top-level tasks require their own.
	if parentID == nil {
		if err := v.ValidateRequiredDate(startDate, "start_date"); err != nil {
			return err
		}
		if err := v.ValidateRequiredDate(endDate, "end_date"); err != nil {
			return err
		}
	}
	return v.ValidateDateRange(startDate, endDate, "task")
}

// validateStatus rejects values outside the fixed 3-state catalog.
func (v *TaskValidator) validateStatus(status string) error {
	switch status {
	case domain.StatusNotStarted, domain.StatusInProgress, domain.StatusDone:
		return nil
	default:
		return errors.NewFieldError("status", "one_of", "недопустимый статус задачи")
	}
}
