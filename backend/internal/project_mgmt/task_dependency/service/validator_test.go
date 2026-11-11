package service_test

import (
	"testing"

	"github.com/Koshsky/erp-backend/internal/project_mgmt/task_dependency/domain"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/task_dependency/service"
	"github.com/Koshsky/erp-backend/pkg/errors"
)

func TestValidateTypeCatalog(t *testing.T) {
	t.Parallel()
	v := &service.DependencyValidator{}

	for _, typ := range []string{domain.TypeFinishToStart, domain.TypeStartToStart, domain.TypeFinishToFinish, domain.TypeStartToFinish} {
		if err := v.ValidateType(typ); err != nil {
			t.Errorf("ValidateType(%s) = %v; want nil", typ, err)
		}
	}
	for _, typ := range []string{"", "fsx", "FS", "F-S", "другое"} {
		if err := v.ValidateType(typ); err == nil {
			t.Errorf("ValidateType(%q) = nil; want an error", typ)
		}
	}
}

func TestValidateCreateIDs(t *testing.T) {
	t.Parallel()
	v := &service.DependencyValidator{}

	if err := v.ValidateCreate(0, 5, domain.TypeFinishToStart); err == nil {
		t.Error("ValidateCreate(0, ...) = nil; want an error (zero task_id)")
	}
	if err := v.ValidateCreate(5, 0, domain.TypeFinishToStart); err == nil {
		t.Error("ValidateCreate(..., 0) = nil; want an error (zero depends_on_task_id)")
	}
	if err := v.ValidateCreate(-1, 5, domain.TypeFinishToStart); err == nil {
		t.Error("ValidateCreate(negative) = nil; want an error")
	}
	if err := v.ValidateCreate(1, 2, "bad"); err == nil {
		t.Error("ValidateCreate(type) = nil; want an error")
	}
	if err := v.ValidateCreate(1, 2, domain.TypeFinishToStart); err != nil {
		t.Errorf("ValidateCreate(valid) = %v; want nil", err)
	}
	if !errors.IsValidationError(v.ValidateCreate(0, 5, domain.TypeFinishToStart)) {
		t.Error("ValidateCreate(0) должен быть validation error")
	}
}
