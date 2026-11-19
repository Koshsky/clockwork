package diagnostics_test

import (
	"context"
	"errors"
	"fmt"
	"net"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/Koshsky/erp-backend/internal/diagnostics"
	apperrors "github.com/Koshsky/erp-backend/internal/errors"
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
		{"configuration", fmt.Errorf("canary-setting: %w", apperrors.ErrConfiguration), "CONFIGURATION_ERROR"},
		{"arguments", apperrors.ErrCommandArguments, "INVALID_ARGUMENTS"},
		{"migration validation", apperrors.ErrMigrationValidation, "MIGRATION_VALIDATION"},
		{"migration execution", errors.Join(apperrors.ErrMigrationExecution, errors.New("canary-sql")), "MIGRATION_EXECUTION"},
		{"network", &net.OpError{Op: "dial", Net: "canary-host", Err: errors.New("canary-address")}, "NETWORK_ERROR"},
		{"network timeout", &net.DNSError{IsTimeout: true, Name: "canary-host"}, "TIMEOUT"},
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
