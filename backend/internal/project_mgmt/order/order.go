// Package order holds small helpers for the explicit per-group ordering of
// processes and tasks (the sort_order column). Shared by the process and task
// services: the same validation applies to both group types.
package order

import (
	"github.com/Koshsky/erp-backend/pkg/errors"
	"github.com/Koshsky/erp-backend/pkg/messages"
)

// RejectDuplicateIDs returns a validation error when the list contains
// duplicate ids (the per-group order uniqueness would otherwise be violated).
func RejectDuplicateIDs(resource string, ids []int64) error {
	seen := make(map[int64]struct{}, len(ids))
	for _, id := range ids {
		if _, ok := seen[id]; ok {
			return errors.NewValidationErrorM(messages.M("order.duplicate_ids", resource))
		}
		seen[id] = struct{}{}
	}
	return nil
}

// SameIDSet reports whether two id lists contain the same id set (ignoring
// order) — a reorder request must not change the group composition.
func SameIDSet(a, b []int64) bool {
	if len(a) != len(b) {
		return false
	}
	set := make(map[int64]struct{}, len(a))
	for _, id := range a {
		set[id] = struct{}{}
	}
	for _, id := range b {
		if _, ok := set[id]; !ok {
			return false
		}
	}
	return true
}
