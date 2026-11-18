package diagnostics_test

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/Koshsky/erp-backend/internal/diagnostics"
	apierrors "github.com/Koshsky/erp-backend/pkg/errors"
)

func TestErrorCodesDoNotFormatSensitiveErrors(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name string
		err  error
		want string
	}{
		{"none", nil, ""},
		{"opaque", errors.New("password=canary-secret Иванов /Users/private/profile"), "INTERNAL_ERROR"},
		{"wrapped timeout", fmt.Errorf("secret URL: %w", context.DeadlineExceeded), "TIMEOUT"},
		{"cancelled", context.Canceled, "CANCELLED"},
		{"database", &pgconn.PgError{Code: "23505", Message: "secret row", Detail: "canary-secret"}, "DATABASE_ERROR"},
		{"conflict", apierrors.Conflict("private task name"), "CONFLICT"},
		{"forbidden", apierrors.ErrForbidden, "FORBIDDEN"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := diagnostics.ErrorCode(tc.err); got != tc.want {
				t.Fatalf("code = %q, want %q", got, tc.want)
			}
		})
	}
}
