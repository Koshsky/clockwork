package service_test

import (
	"context"
	"errors"
	"log/slog"
	"testing"

	"github.com/Koshsky/erp-backend/internal/authz/repository/sqlc"
	"github.com/Koshsky/erp-backend/internal/authz/service"
	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
)

type failingPolicyRepository struct {
	service.PolicyRepository

	failure error
	seen    context.Context
	calls   int
}

func (r *failingPolicyRepository) ListActiveRules(ctx context.Context) ([]sqlc.ListActivePresetRulesRow, error) {
	r.seen = ctx
	r.calls++
	return nil, r.failure
}

func TestPolicyStoreConstructorPreservesLoadFailures(t *testing.T) {
	t.Parallel()
	for _, cancelled := range []bool{false, true} {
		name := "unavailable repository"
		if cancelled {
			name = "cancelled load"
		}
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			failure := errors.New("policy database unavailable")
			if cancelled {
				cancel()
				failure = context.Canceled
			}
			repository := &failingPolicyRepository{failure: failure}
			store := service.NewPolicyStore(slog.New(slog.DiscardHandler), repository, &rbac.Middleware{}, 0)
			if err := store.Reload(ctx); !errors.Is(err, failure) || repository.seen != ctx || repository.calls != 1 {
				t.Fatalf("repository failure/context changed: err=%v calls=%d", err, repository.calls)
			}
			principal, err := store.EffectiveUser(t.Context(), 7)
			if err != nil || principal.ID != 7 || principal.Admin || principal.Preset != "" ||
				len(principal.Rules) != 0 {
				t.Fatalf("failed load did not preserve default deny: %+v, %v", principal, err)
			}
		})
	}
}
