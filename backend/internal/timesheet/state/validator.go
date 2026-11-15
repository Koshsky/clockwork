package state

import (
	"github.com/Koshsky/erp-backend/pkg/validator"
)

type Validator struct {
	validator.Validator
}

func (v *Validator) ValidateState(code, name string, color *string) error {
	if err := v.ValidateRequiredText(code, "code"); err != nil {
		return err
	}
	if err := v.ValidateOptionalColor(color, "color"); err != nil {
		return err
	}
	return v.ValidateRequiredText(name, "name")
}
