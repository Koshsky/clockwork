package validator

import (
	"regexp"
	"strings"

	"github.com/Koshsky/erp-backend/pkg/date"
	"github.com/Koshsky/erp-backend/pkg/errors"
)

type Validator struct{}

func New() *Validator {
	return &Validator{}
}

func (v *Validator) ValidateDateRange(start, end date.Date, entity string) error {
	if end.Time().Before(start.Time()) {
		return errors.NewFieldErrorM("end_date", codeDateRange, msgDateRange(entity))
	}
	return nil
}

func (v *Validator) ValidateRequiredText(value, field string) error {
	if strings.TrimSpace(value) == "" {
		return errors.NewFieldErrorM(field, codeRequired, msgRequired(field))
	}
	return nil
}

func (v *Validator) ValidatePositiveID(id int64, field string) error {
	if id <= 0 {
		return errors.NewFieldErrorM(field, codeMinValue, msgGreaterThan(field, 0))
	}
	return nil
}

// ValidateOptionalPositiveID validates a nullable positive id: nil means "not
// set"; a value must be strictly positive.
func (v *Validator) ValidateOptionalPositiveID(id *int64, field string) error {
	if id == nil {
		return nil
	}
	return v.ValidatePositiveID(*id, field)
}

func (v *Validator) ValidateRequiredDate(value date.Date, field string) error {
	if value == "" {
		return errors.NewFieldErrorM(field, codeRequired, msgRequired(field))
	}
	return nil
}

// entityColorPattern is the only accepted color format: #RRGGBB.
const entityColorPattern = "^#[0-9a-fA-F]{6}$"

// ValidateOptionalColor validates an optional entity color: nil/empty means
// "no custom color" (the frontend then uses its standard color); a value must
// be a six-digit hex string (#RRGGBB).
func (v *Validator) ValidateOptionalColor(color *string, field string) error {
	if color == nil || *color == "" {
		return nil
	}
	ok, err := regexp.MatchString(entityColorPattern, *color)
	if err != nil || !ok {
		return errors.NewFieldErrorM(field, codeFormat, msgFormat(field))
	}
	return nil
}
