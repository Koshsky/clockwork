package engine

import (
	"context"

	access "github.com/Koshsky/erp-backend/internal/authz/domain"
)

// AssignmentOwnersAllowed retains the own-task/own-resource restriction for parent scope.
func AssignmentOwnersAllowed(user access.UserContext, action Action, owners access.Owners) bool {
	return scopeForUser(user, access.ResourceAssignment, action) != ScopeParent ||
		(owners.Owner == user.ID && owners.ResourceOwner == user.ID)
}

// AuthorizeAssignment checks resolved facts without allowing an administrator to bypass owner equality.
func AuthorizeAssignment(
	ctx context.Context,
	user access.UserContext,
	action Action,
	taskID int64,
	taskOwners, resourceOwners access.Owners,
) bool {
	if taskOwners.ProcessOwner == 0 || taskOwners.ProcessOwner != resourceOwners.Owner {
		return false
	}
	if !EnforceTarget(user, Target{
		Res: access.ResourceTask, Act: ActionView, Owners: taskOwners, ID: taskID, Ctx: ctx,
	}) {
		return false
	}
	owners := taskOwners
	owners.ResourceOwner = resourceOwners.Owner
	if !AssignmentOwnersAllowed(user, action, owners) {
		return false
	}
	return EnforceTarget(user, Target{Res: access.ResourceAssignment, Act: action, Owners: taskOwners, Ctx: ctx})
}
