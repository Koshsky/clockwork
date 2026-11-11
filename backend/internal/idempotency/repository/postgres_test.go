//nolint:testpackage // unit test of the unexported reclaimable predicate
package repository

import (
	"testing"
	"time"

	"github.com/Koshsky/erp-backend/internal/idempotency/repository/sqlc"
)

func TestReclaimable(t *testing.T) {
	t.Parallel()
	now := time.Now()
	lease := 2 * time.Minute

	key := func(status int32, createdAgo time.Duration, expiresIn time.Duration) sqlc.IdempotencyKey {
		return sqlc.IdempotencyKey{
			ResponseStatus: status,
			CreatedAt:      now.Add(-createdAgo),
			ExpiresAt:      now.Add(expiresIn),
		}
	}

	cases := []struct {
		name     string
		existing sqlc.IdempotencyKey
		want     bool
	}{
		{"in-flight younger than lease: keep", key(0, time.Minute, 24*time.Hour), false},
		{"in-flight older than lease: reclaim", key(0, 5*time.Minute, 24*time.Hour), true},
		{"completed not expired: replay", key(201, time.Minute, 24*time.Hour), false},
		{"completed expired: reclaim", key(201, 25*time.Hour, -time.Hour), true},
		{"in-flight but expired: reclaim", key(0, 25*time.Hour, -time.Hour), true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := reclaimable(tc.existing, now, lease); got != tc.want {
				t.Errorf("reclaimable(%+v) = %v, want %v", tc.existing, got, tc.want)
			}
		})
	}
}
