package engine

// Ownership tree registry: the parent/child structure of business resources
// (project → process → task → assignment/subtask; process → milestone;
// resource/worker form their own small tree). The registry is the PHYSICAL
// mapping (node type → parent type, owner-bearing flags, owner-bearing
// descendants) that the scope evaluator (eval.go) and the SQL generator
// (sqlscope.go) walk. Business rules on top are data (scope expressions), not
// code: adding a tree level means extending this registry, not new zone logic.

import "github.com/Koshsky/erp-backend/internal/middleware/rbac"

//nolint:gochecknoglobals // derived applicability tables (tree registry)
var nodeHasOwner = map[rbac.Resource]bool{
	rbac.ResourceProject:      true,
	rbac.ResourceProcess:      true,
	rbac.ResourceTask:         true,
	rbac.ResourceMilestone:    false,
	rbac.ResourceAssignment:   false,
	rbac.ResourceResource:     true,
	rbac.ResourceWorker:       true,
	rbac.ResourceState:        false,
	rbac.ResourceComment:      false,
	rbac.ResourceUserCatalog:  false,
	rbac.ResourceRBACConfig:   false,
	rbac.ResourceUserAdmin:    false,
	rbac.ResourceStateAdmin:   false,
	rbac.ResourceOrgStructure: false,
	rbac.ResourceAudit:        false,
	rbac.ResourceAutoCreate:   false,
}

//nolint:gochecknoglobals // derived applicability tables
var nodeHasParent = map[rbac.Resource]bool{
	rbac.ResourceProject:      false,
	rbac.ResourceProcess:      true,
	rbac.ResourceTask:         true,
	rbac.ResourceMilestone:    true,
	rbac.ResourceAssignment:   true,
	rbac.ResourceResource:     false,
	rbac.ResourceWorker:       false,
	rbac.ResourceState:        false,
	rbac.ResourceComment:      false,
	rbac.ResourceUserCatalog:  false,
	rbac.ResourceRBACConfig:   false,
	rbac.ResourceUserAdmin:    false,
	rbac.ResourceStateAdmin:   false,
	rbac.ResourceOrgStructure: false,
	rbac.ResourceAudit:        false,
	rbac.ResourceAutoCreate:   false,
}

//nolint:gochecknoglobals // derived applicability tables
var ownerDescendants = map[rbac.Resource][]rbac.Resource{
	rbac.ResourceProject:      {rbac.ResourceProcess, rbac.ResourceTask},
	rbac.ResourceProcess:      {rbac.ResourceTask},
	rbac.ResourceTask:         {rbac.ResourceTask}, // subtasks
	rbac.ResourceMilestone:    nil,
	rbac.ResourceAssignment:   nil,
	rbac.ResourceResource:     nil,
	rbac.ResourceWorker:       nil,
	rbac.ResourceState:        nil,
	rbac.ResourceComment:      nil,
	rbac.ResourceUserCatalog:  nil,
	rbac.ResourceRBACConfig:   nil,
	rbac.ResourceUserAdmin:    nil,
	rbac.ResourceStateAdmin:   nil,
	rbac.ResourceOrgStructure: nil,
	rbac.ResourceAudit:        nil,
	rbac.ResourceAutoCreate:   nil,
}
