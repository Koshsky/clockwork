package engine_test

import (
	"testing"

	access "github.com/Koshsky/erp-backend/internal/authz/domain"
	"github.com/Koshsky/erp-backend/internal/authz/engine"
)

//nolint:paralleltest // Publishes and restores the shared authorization snapshot.
func TestAssignmentAuthorizationUsesResolvedFacts(t *testing.T) {
	publishWithRules(t, []engine.RuleGrant{
		{Sub: "42", Key: "assignment/create", Scope: engine.ScopeParent},
		{Sub: "42", Key: "task/view", Scope: engine.ScopeParent},
		{Sub: "43", Key: "assignment/create", Scope: engine.ScopeAll},
		{Sub: "43", Key: "task/view", Scope: engine.ScopeAll},
		{Sub: "44", Key: "assignment/create", Scope: engine.ScopeAll},
	}, nil, nil)
	for _, tc := range []struct {
		name                                           string
		userID, processOwner, taskOwner, resourceOwner int64
		admin, want                                    bool
	}{
		{"own task and resource", 42, 42, 42, 42, false, true},
		{"foreign task in own process", 42, 42, 9, 42, false, false},
		{"foreign resource", 42, 42, 42, 9, false, false},
		{"all scope with common owner", 43, 9, 9, 9, false, true},
		{"all scope with mismatched owners", 43, 9, 9, 42, false, false},
		{"task view still required", 44, 9, 9, 9, false, false},
		{"admin common owner", 1, 9, 9, 9, true, true},
		{"admin cannot bypass owner equality", 1, 9, 9, 42, true, false},
		{"zero is not a common owner", 1, 0, 0, 0, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := engine.AuthorizeAssignment(
				t.Context(), access.UserContext{ID: tc.userID, Preset: "worker", Admin: tc.admin},
				engine.ActionCreate, 7,
				access.Owners{ProjectOwner: 9, ProcessOwner: tc.processOwner, Owner: tc.taskOwner},
				access.Owners{Owner: tc.resourceOwner},
			)
			if got != tc.want {
				t.Errorf("resolved assignment authorization = %v, want %v", got, tc.want)
			}
		})
	}
}
