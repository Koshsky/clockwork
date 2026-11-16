package rbac

import (
	access "github.com/Koshsky/erp-backend/internal/authz/domain"
	"github.com/Koshsky/erp-backend/internal/authz/engine"
	"github.com/Koshsky/erp-backend/pkg/errors"
)

func checkTaskCreateParent(rc *CheckCtx) error {
	parentID, err := rc.BodyID("parent_id")
	if err != nil || parentID == 0 {
		return err
	}
	owners, err := rc.Owners(access.ResourceTask, parentID)
	if err != nil {
		return err
	}
	if !engine.EnforceTarget(rc.User, engine.Target{
		Res: access.ResourceTask, Act: engine.ActionView, Owners: owners, ID: parentID, Ctx: rc.C.Request.Context(),
	}) {
		return errors.ErrForbidden
	}
	return nil
}
