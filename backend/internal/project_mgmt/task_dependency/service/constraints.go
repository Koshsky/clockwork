package service

import (
	"github.com/Koshsky/erp-backend/internal/project_mgmt/task_dependency/domain"
	"github.com/Koshsky/erp-backend/pkg/date"
	"github.com/Koshsky/erp-backend/pkg/errors"
	"github.com/Koshsky/erp-backend/pkg/messages"
)

// boundDate returns the date of the successor that the link constrains: its
// start for fs/ss, its end for ff/sf.
func boundDate(typ string, taskStart, taskEnd date.Date) date.Date {
	if domain.BoundIsStart(typ) {
		return taskStart
	}
	return taskEnd
}

// anchorDate returns the date of the predecessor that anchors the constraint:
// its start for ss/sf, its end for fs/ff.
func anchorDate(typ string, predStart, predEnd date.Date) date.Date {
	if domain.AnchorIsStart(typ) {
		return predStart
	}
	return predEnd
}

// violationTemplate picks the user-facing message template for a violated
// link, carrying both task titles as arguments.
func violationTemplate(typ, taskTitle, predTitle string) messages.Message {
	switch typ {
	case domain.TypeFinishToStart:
		return messages.M("task_dependency.finish_to_start", taskTitle, predTitle)
	case domain.TypeStartToStart:
		return messages.M("task_dependency.start_to_start", taskTitle, predTitle)
	case domain.TypeFinishToFinish:
		return messages.M("task_dependency.finish_to_finish", taskTitle, predTitle)
	case domain.TypeStartToFinish:
		return messages.M("task_dependency.start_to_finish", taskTitle, predTitle)
	default:
		return messages.M("task_dependency.invalid_type")
	}
}

// checkConstraint validates one link: the successor's bound date must not
// precede the predecessor's anchor date. The rule is INCLUSIVE (`>=`): a bound
// landing exactly on the anchor date is valid — there is no minimum one-day
// lag, so only a strictly earlier bound is a violation. A violation is returned
// as a validation error (400) so the conflicting pair is visible to the user.
func checkConstraint(
	taskTitle string,
	taskStart, taskEnd date.Date,
	typ, predTitle string,
	predStart, predEnd date.Date,
) error {
	if boundDate(typ, taskStart, taskEnd) < anchorDate(typ, predStart, predEnd) {
		return errors.NewValidationErrorM(violationTemplate(typ, taskTitle, predTitle))
	}
	return nil
}
