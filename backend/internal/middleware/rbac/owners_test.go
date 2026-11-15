package rbac_test

import (
	"context"
	"errors"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/Koshsky/erp-backend/internal/authz/domain"
	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	errorsapi "github.com/Koshsky/erp-backend/pkg/errors"
)

func TestOwnerResolverPreservesRequestContext(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	want := domain.Owners{ProjectOwner: 7, ProcessOwner: 9, Owner: 11, ResourceOwner: 9}
	resolver := domain.ResolveByID(func(got context.Context, id int64) (domain.Owners, error) {
		if got != ctx || id != 42 {
			t.Errorf("resolver received context %v and id %d", got, id)
		}
		if err := got.Err(); err != nil {
			return domain.Owners{}, err
		}
		return want, nil
	})
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequestWithContext(ctx, "GET", "/", nil)
	check := rbac.CheckCtx{C: c, Data: rbac.Data{TaskOwners: resolver}}
	got, err := check.Owners(domain.ResourceTask, 42)
	if err != nil || got != want {
		t.Fatalf("Owners() = %+v, %v; want %+v", got, err, want)
	}
	cancel()
	if _, err = check.Owners(domain.ResourceTask, 42); !errors.Is(err, context.Canceled) {
		t.Errorf("cancellation lost by owner resolution: %v", err)
	}
	if _, err = check.Owners(domain.ResourceProject, 42); !errorsapi.IsNotFoundError(err) {
		t.Errorf("missing resolver = %v, want not found", err)
	}
	if _, err = check.Owners(domain.ResourceUserCatalog, 42); !errorsapi.IsNotFoundError(err) {
		t.Errorf("unowned virtual resource = %v, want not found", err)
	}
}
