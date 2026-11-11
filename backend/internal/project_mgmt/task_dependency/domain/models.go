package domain

// Dependency type catalog (fixed 4-set — see the task_dependencies.type CHECK):
// fs — finish-to-start, ss — start-to-start, ff — finish-to-finish,
// sf — start-to-finish. The successor (task_id) must not start/finish before
// the predecessor (depends_on_task_id); the exact rule per type:
//
//	fs — successor starts after the predecessor ends,
//	ss — successor starts after the predecessor starts,
//	ff — successor ends after the predecessor ends,
//	sf — successor ends after the predecessor starts.
const (
	TypeFinishToStart  = "fs"
	TypeStartToStart   = "ss"
	TypeFinishToFinish = "ff"
	TypeStartToFinish  = "sf"
)

// ValidType reports whether the value is one of the catalog types.
func ValidType(typ string) bool {
	switch typ {
	case TypeFinishToStart, TypeStartToStart, TypeFinishToFinish, TypeStartToFinish:
		return true
	default:
		return false
	}
}

// BoundIsStart reports whether the constraint bounds the successor's start
// date (fs/ss); otherwise it bounds the successor's end date (ff/sf).
func BoundIsStart(typ string) bool {
	return typ == TypeFinishToStart || typ == TypeStartToStart
}

// AnchorIsStart reports whether the constraint anchors the predecessor's
// start date (ss/sf); otherwise it anchors the predecessor's end date (fs/ff).
func AnchorIsStart(typ string) bool {
	return typ == TypeStartToStart || typ == TypeStartToFinish
}
