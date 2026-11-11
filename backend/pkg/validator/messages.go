package validator

import "github.com/Koshsky/erp-backend/pkg/messages"

// Machine-readable codes for FieldError. Centralized here so message wording
// and codes evolve in one place (e.g. for future localization or structured
// API error payloads) instead of being scattered across Validator methods.
const (
	codeRequired  = "required"
	codeMinValue  = "min_value"
	codeDateRange = "date_range"
	codeOneOf     = "one_of"
	codeFormat    = "format"
)

// The message template ids below live in the pkg/messages catalogs
// (catalog_ru.json / catalog_en.json) — the coverage test enforces that every
// id used here exists in both languages.

// msgRequired is the "field is required" message template.
func msgRequired(field string) messages.Message {
	return messages.M("validator.required", field)
}

// msgGreaterThan is the "field must be greater than a value" message template.
func msgGreaterThan(field string, minVal int) messages.Message {
	return messages.M("validator.min_value", field, minVal)
}

// msgDateRange is the "end date must not precede the start date" template for
// an entity.
func msgDateRange(entity string) messages.Message {
	return messages.M("validator.date_range", entity)
}

// msgFormat is the "field must be a hex color" message template.
func msgFormat(field string) messages.Message {
	return messages.M("validator.color_format", field)
}
