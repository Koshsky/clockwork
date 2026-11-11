package service

import (
	"github.com/Koshsky/erp-backend/pkg/date"
	"github.com/Koshsky/erp-backend/pkg/errors"
	"github.com/Koshsky/erp-backend/pkg/validator"
)

// maxAbsenceRange is the maximum width of the absence request window (in days).
const (
	maxAbsenceRange = 3660
	hoursPerDay     = 24
)

type ResourceValidator struct {
	validator.Validator
}

func (v *ResourceValidator) ValidateResource(code, title string, color *string) error {
	if err := v.ValidateRequiredText(code, "code"); err != nil {
		return err
	}
	if err := v.ValidateOptionalColor(color, "color"); err != nil {
		return err
	}
	return v.ValidateRequiredText(title, "title")
}

// ValidateDayRange checks that a date window is present and ordered.
func (v *ResourceValidator) ValidateDayRange(start, end date.Date) error {
	if start == "" {
		return errors.NewFieldError("start_date", "required", "start_date is required")
	}
	if end == "" {
		return errors.NewFieldError("end_date", "required", "end_date is required")
	}
	if end.Time().Before(start.Time()) {
		return errors.NewFieldError("end_date", "date_range", "end_date must be >= start_date")
	}
	if int(end.Time().Sub(start.Time()).Hours()/hoursPerDay) > maxAbsenceRange {
		return errors.NewValidationError("date range is too wide")
	}
	return nil
}
