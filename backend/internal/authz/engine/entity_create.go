package engine

import (
	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	"github.com/Koshsky/erp-backend/pkg/errors"
)

func checkTaskCreateParent(rc *rbac.CheckCtx) error {
	parentID, err := rc.BodyID("parent_id")
	if err != nil || parentID == 0 {
		return err
	}
	owners, err := rc.Owners(rbac.ResourceTask, parentID)
	if err != nil {
		return err
	}
	if !EnforceTarget(rc.User, Target{
		Res: rbac.ResourceTask, Act: ActionView, Owners: owners, ID: parentID, Ctx: rc.C.Request.Context(),
	}) {
		return errors.ErrForbidden
	}
	return nil
}
