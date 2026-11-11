package service

import (
	"github.com/Koshsky/erp-backend/pkg/validator"
)

type StateValidator struct {
	validator.Validator
}

func (v *StateValidator) ValidateState(code, name string, color *string) error {
	if err := v.ValidateRequiredText(code, "code"); err != nil {
		return err
	}
	if err := v.ValidateOptionalColor(color, "color"); err != nil {
		return err
	}
	return v.ValidateRequiredText(name, "name")
}
