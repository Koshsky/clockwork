package rbac

import (
	"encoding/json"
	"strings"

	access "github.com/Koshsky/erp-backend/internal/authz/domain"
	"github.com/Koshsky/erp-backend/internal/authz/engine"
	"github.com/Koshsky/erp-backend/pkg/errors"
)

func checkEntityUpdate(rc *CheckCtx, res access.Resource, owners access.Owners, id int64) error {
	if res == access.ResourceAssignment {
		return checkAssignmentUpdate(rc, owners, id)
	}
	if res == access.ResourceProcess {
		return checkProcessUpdate(rc, owners, id)
	}
	if res == access.ResourceMilestone {
		processID, err := rc.BodyID(bodyKeyProcessID)
		if err != nil || processID == 0 {
			return err
		}
		owners, err = rc.Owners(access.ResourceProcess, processID)
		if err != nil {
			return err
		}
		return enforceUpdateTarget(rc, res, owners, id)
	}
	if res != access.ResourceProject && res != access.ResourceProcess &&
		res != access.ResourceTask && res != access.ResourceResource {
		return nil
	}
	ownerID, err := rc.BodyID(bodyKeyOwnerID)
	if err != nil || ownerID == 0 {
		return err
	}
	if res == access.ResourceProject {
		owners.ProjectOwner = ownerID
		return enforceUpdateTarget(rc, res, owners, id)
	}
	if res == access.ResourceProcess {
		owners.ProcessOwner = ownerID
		return enforceUpdateTarget(rc, res, owners, id)
	}
	owners.Owner = ownerID
	return enforceUpdateTarget(rc, res, owners, id)
}

func checkProcessUpdate(rc *CheckCtx, owners access.Owners, id int64) error {
	projectID, err := rc.BodyID(bodyKeyProjectID)
	if err != nil {
		return err
	}
	ownerID, err := rc.BodyID(bodyKeyOwnerID)
	if err != nil || (projectID == 0 && ownerID == 0) {
		return err
	}
	if projectID != 0 {
		projectOwners, resolveErr := rc.Owners(access.ResourceProject, projectID)
		if resolveErr != nil {
			return resolveErr
		}
		owners.ProjectOwner = projectOwners.ProjectOwner
	}
	if ownerID != 0 {
		owners.ProcessOwner = ownerID
	}
	return enforceUpdateTarget(rc, access.ResourceProcess, owners, id)
}

func checkAssignmentUpdate(rc *CheckCtx, owners access.Owners, id int64) error {
	taskID, err := rc.BodyID(bodyKeyTaskID)
	if err != nil {
		return err
	}
	resourceID, err := rc.BodyID(bodyKeyResourceID)
	if err != nil || (taskID == 0 && resourceID == 0) {
		return err
	}
	if taskID != 0 {
		taskOwners, resolveErr := rc.Owners(access.ResourceTask, taskID)
		if resolveErr != nil {
			return resolveErr
		}
		if !engine.EnforceTarget(rc.User, engine.Target{
			Res:    access.ResourceTask,
			Act:    engine.ActionView,
			Owners: taskOwners,
			ID:     taskID,
			Ctx:    rc.C.Request.Context(),
		}) {
			return errors.ErrForbidden
		}
		taskOwners.ResourceOwner = owners.ResourceOwner
		owners = taskOwners
	}
	if resourceID != 0 {
		resourceOwners, resolveErr := rc.Owners(access.ResourceResource, resourceID)
		if resolveErr != nil {
			return resolveErr
		}
		owners.ResourceOwner = resourceOwners.Owner
	}
	if !engine.AssignmentOwnersAllowed(rc.User, engine.ActionUpdate, owners) {
		return errors.ErrForbidden
	}
	return enforceUpdateTarget(rc, access.ResourceAssignment, owners, id)
}

func enforceUpdateTarget(rc *CheckCtx, res access.Resource, owners access.Owners, id int64) error {
	// Authorizing only the stored row would let an update escape its ownership scope.
	var parentID int64
	if res == access.ResourceProcess {
		var err error
		parentID, err = rc.BodyID(bodyKeyProjectID)
		if err != nil {
			return err
		}
	}
	target := engine.Target{
		Res: res, Act: engine.ActionUpdate, Owners: owners, ID: id, ParentID: parentID, Ctx: rc.C.Request.Context(),
	}
	if parentID != 0 {
		target.ParentVisible = engine.EnforceTarget(rc.User, engine.Target{
			Res: access.ResourceProject, Act: engine.ActionView, Owners: owners, ID: parentID, Ctx: target.Ctx,
		})
	}
	if !engine.EnforceTarget(rc.User, target) {
		return errors.ErrForbidden
	}
	return nil
}

func checkProjectUpdate(rc *CheckCtx, owners access.Owners, id int64) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(rc.Body(), &fields); err != nil || fields == nil {
		return errors.BadRequest("invalid project update")
	}
	priority := false
	for key := range fields {
		priority = priority || strings.EqualFold(key, "priority")
	}
	metadata := len(fields) == 0 || len(fields) > 1 || !priority
	for _, check := range []struct {
		required bool
		action   engine.Action
	}{{priority, engine.ActionPrioritize}, {metadata, engine.ActionUpdate}} {
		if check.required && !engine.EnforceTarget(rc.User, engine.Target{
			Res: access.ResourceProject, Act: check.action, Owners: owners, ID: id, Ctx: rc.C.Request.Context(),
		}) {
			return errors.ErrForbidden
		}
	}
	if metadata {
		return checkEntityUpdate(rc, access.ResourceProject, owners, id)
	}
	return nil
}
