package service

import (
	"github.com/Koshsky/erp-backend/pkg/date"
	"github.com/Koshsky/erp-backend/pkg/validator"
)

type ProcessValidator struct {
	validator.Validator
}

func (v *ProcessValidator) ValidateProcess(
	projectID int64,
	title string,
	color *string,
	startDate, endDate date.Date,
) error {
	if err := v.ValidatePositiveID(projectID, "project_id"); err != nil {
		return err
	}
	if err := v.ValidateRequiredText(title, "title"); err != nil {
		return err
	}
	if err := v.ValidateOptionalColor(color, "color"); err != nil {
		return err
	}
	if err := v.ValidateRequiredDate(startDate, "start_date"); err != nil {
		return err
	}
	if err := v.ValidateRequiredDate(endDate, "end_date"); err != nil {
		return err
	}
	return v.ValidateDateRange(startDate, endDate, "process")
}
