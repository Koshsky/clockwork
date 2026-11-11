package audit

// Entity and action codes for the route classification. Constants (not string
// literals) keep the static table free of duplicated literals.
const (
	entProject        = "project"
	entProcess        = "process"
	entTask           = "task"
	entComment        = "comment"
	entTaskDependency = "task_dependency"
	entMilestone      = "milestone"
	entAssignment     = "assignment"
	entResource       = "resource"
	entResourceMember = "resource_member"
	entState          = "state"
	entAutoCreate     = "auto_create"
	entRBAC           = "rbac"

	actCreate        = "create"
	actUpdate        = "update"
	actDelete        = "delete"
	actReorder       = "reorder"
	actAdd           = "add"
	actRemove        = "remove"
	actUpdateManager = "update_manager"
	actResetPassword = "reset_password"
	actSetDays       = "set_days"
	actDeleteDays    = "delete_days"
	actCreateRole    = "create_preset"
	actUpdateRole    = "update_preset"
	actDeleteRole    = "delete_preset"
	actUpsertRule    = "upsert_preset_rule"
	actDeleteRule    = "delete_preset_rule"
	actUpsertPolicy  = "upsert_policy"
	actDeletePolicy  = "delete_policy"
	actReplacePerms  = "replace_user_permissions"
	actReset         = "reset"
)

// routeClass maps a matched full route (method + path template) to the audit
// entity/action and the URL param that identifies the affected entity.
type routeClass struct {
	entity  string
	action  string
	idParam string // gin URL param with the entity id ("" — none/unknown)
}

// routeClasses is the static classification of every mutation route in the
// API (public /auth/* and protected CRUD). Keys are "METHOD /api/v1/...".
//
//nolint:gochecknoglobals // static route classification table (established pattern)
var routeClasses = map[string]routeClass{
	// ---- auth (public) / self-service ----
	// POST /auth/refresh is intentionally NOT logged: it fires on every page
	// reload and token expiry (~15 min) — automatic session noise, not a
	// user-visible mutation.
	"POST /api/v1/auth/login":           {entity: entityAuth, action: actionLogin},
	"POST /api/v1/auth/logout":          {entity: entityAuth, action: actionLogout},
	"POST /api/v1/user/change-password": {entity: entityUser, action: actionChangePass},

	// ---- projects ----
	"POST /api/v1/project":       {entity: entProject, action: actCreate},
	"PUT /api/v1/project/:id":    {entity: entProject, action: actUpdate, idParam: "id"},
	"DELETE /api/v1/project/:id": {entity: entProject, action: actDelete, idParam: "id"},

	// ---- processes ----
	"POST /api/v1/process":       {entity: entProcess, action: actCreate},
	"PUT /api/v1/process/order":  {entity: entProcess, action: actReorder},
	"PUT /api/v1/process/:id":    {entity: entProcess, action: actUpdate, idParam: "id"},
	"DELETE /api/v1/process/:id": {entity: entProcess, action: actDelete, idParam: "id"},

	// ---- tasks ----
	"POST /api/v1/task":       {entity: entTask, action: actCreate},
	"PUT /api/v1/task/order":  {entity: entTask, action: actReorder},
	"PUT /api/v1/task/:id":    {entity: entTask, action: actUpdate, idParam: "id"},
	"DELETE /api/v1/task/:id": {entity: entTask, action: actDelete, idParam: "id"},

	// ---- comments (nested under /task/:id/comments) ----
	"POST /api/v1/task/:id/comments":               {entity: entComment, action: actCreate, idParam: "id"},
	"DELETE /api/v1/task/:id/comments/:comment_id": {entity: entComment, action: actDelete, idParam: "comment_id"},

	// ---- task dependencies (nested under /task/:id/dependencies) ----
	"POST /api/v1/task/:id/dependencies":           {entity: entTaskDependency, action: actCreate, idParam: "id"},
	"PUT /api/v1/task/:id/dependencies/:dep_id":    {entity: entTaskDependency, action: actUpdate, idParam: "dep_id"},
	"DELETE /api/v1/task/:id/dependencies/:dep_id": {entity: entTaskDependency, action: actDelete, idParam: "dep_id"},

	// ---- milestones ----
	"POST /api/v1/milestone":       {entity: entMilestone, action: actCreate},
	"PUT /api/v1/milestone/:id":    {entity: entMilestone, action: actUpdate, idParam: "id"},
	"DELETE /api/v1/milestone/:id": {entity: entMilestone, action: actDelete, idParam: "id"},

	// ---- assignments ----
	"POST /api/v1/assignment":       {entity: entAssignment, action: actCreate},
	"PUT /api/v1/assignment/:id":    {entity: entAssignment, action: actUpdate, idParam: "id"},
	"DELETE /api/v1/assignment/:id": {entity: entAssignment, action: actDelete, idParam: "id"},

	// ---- resources (timesheet) ----
	"POST /api/v1/resources":                       {entity: entResource, action: actCreate},
	"PUT /api/v1/resources/:id":                    {entity: entResource, action: actUpdate, idParam: "id"},
	"DELETE /api/v1/resources/:id":                 {entity: entResource, action: actDelete, idParam: "id"},
	"POST /api/v1/resources/:id/members":           {entity: entResourceMember, action: actAdd, idParam: "id"},
	"DELETE /api/v1/resources/:id/members/:userId": {entity: entResourceMember, action: actRemove, idParam: "userId"},

	// ---- states (timesheet dictionary) ----
	"POST /api/v1/timesheet/states":       {entity: entState, action: actCreate},
	"PUT /api/v1/timesheet/states/:id":    {entity: entState, action: actUpdate, idParam: "id"},
	"DELETE /api/v1/timesheet/states/:id": {entity: entState, action: actDelete, idParam: "id"},

	// ---- users / workers ----
	"POST /api/v1/user":                    {entity: entityUser, action: actCreate},
	"PUT /api/v1/user/:id":                 {entity: entityUser, action: actUpdate, idParam: "id"},
	"PUT /api/v1/user/:id/manager":         {entity: entityUser, action: actUpdateManager, idParam: "id"},
	"DELETE /api/v1/user/:id":              {entity: entityUser, action: actDelete, idParam: "id"},
	"POST /api/v1/user/:id/reset-password": {entity: entityUser, action: actResetPassword, idParam: "id"},
	"PUT /api/v1/user/:id/days":            {entity: entityUser, action: actSetDays, idParam: "id"},
	"DELETE /api/v1/user/:id/days":         {entity: entityUser, action: actDeleteDays, idParam: "id"},

	// ---- auto-create config ----
	"PUT /api/v1/auto-create/config": {entity: entAutoCreate, action: actUpdate},

	// ---- RBAC admin ----
	"POST /api/v1/rbac/presets":              {entity: entRBAC, action: actCreateRole},
	"PUT /api/v1/rbac/presets/:name":         {entity: entRBAC, action: actUpdateRole},
	"DELETE /api/v1/rbac/presets/:name":      {entity: entRBAC, action: actDeleteRole},
	"PUT /api/v1/rbac/preset-rules":          {entity: entRBAC, action: actUpsertRule},
	"DELETE /api/v1/rbac/preset-rules/:id":   {entity: entRBAC, action: actDeleteRule, idParam: "id"},
	"PUT /api/v1/rbac/users/:id/permissions": {entity: entRBAC, action: actReplacePerms, idParam: "id"},
	"PUT /api/v1/rbac/policies":              {entity: entRBAC, action: actUpsertPolicy},
	"DELETE /api/v1/rbac/policies/:name":     {entity: entRBAC, action: actDeletePolicy},
	"POST /api/v1/rbac/reset":                {entity: entRBAC, action: actReset},
}

// classify returns the audit class for a matched route.
func classify(method, fullPath string) (routeClass, bool) {
	rc, ok := routeClasses[method+" "+fullPath]
	return rc, ok
}
