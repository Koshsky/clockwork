package service

import (
	"github.com/Koshsky/erp-backend/pkg/date"
	"github.com/Koshsky/erp-backend/pkg/errors"
	"github.com/Koshsky/erp-backend/pkg/validator"
)

type ProjectValidator struct {
	validator.Validator
}

func (v *ProjectValidator) ValidateProject(
	code string,
	color *string,
	priority int,
	startDate, endDate date.Date,
) error {
	if err := v.ValidateRequiredText(code, "code"); err != nil {
		return err
	}
	if err := v.ValidateOptionalColor(color, "color"); err != nil {
		return err
	}
	if priority < 0 {
		return errors.NewValidationError("priority must be positive")
	}
	if err := v.ValidateRequiredDate(startDate, "start_date"); err != nil {
		return err
	}
	if err := v.ValidateRequiredDate(endDate, "end_date"); err != nil {
		return err
	}
	return v.ValidateDateRange(startDate, endDate, "project")
}
