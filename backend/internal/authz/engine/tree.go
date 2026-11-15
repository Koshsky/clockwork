package engine

// Ownership tree registry: the parent/child structure of business resources
// (project → process → task → assignment/subtask; process → milestone;
// resource/worker form their own small tree). The registry is the PHYSICAL
// mapping (node type → parent type, owner-bearing flags, owner-bearing
// descendants) that the scope evaluator (eval.go) and the SQL generator
// (sqlscope.go) walk. Business rules on top are data (scope expressions), not
// code: adding a tree level means extending this registry, not new zone logic.

import (
	access "github.com/Koshsky/erp-backend/internal/authz/domain"
)

//nolint:gochecknoglobals // derived applicability tables (tree registry)
var nodeHasOwner = map[access.Resource]bool{
	access.ResourceProject:      true,
	access.ResourceProcess:      true,
	access.ResourceTask:         true,
	access.ResourceMilestone:    false,
	access.ResourceAssignment:   false,
	access.ResourceResource:     true,
	access.ResourceWorker:       true,
	access.ResourceState:        false,
	access.ResourceComment:      false,
	access.ResourceUserCatalog:  false,
	access.ResourceRBACConfig:   false,
	access.ResourceUserAdmin:    false,
	access.ResourceStateAdmin:   false,
	access.ResourceOrgStructure: false,
	access.ResourceAudit:        false,
	access.ResourceAutoCreate:   false,
}

//nolint:gochecknoglobals // derived applicability tables
var nodeHasParent = map[access.Resource]bool{
	access.ResourceProject:      false,
	access.ResourceProcess:      true,
	access.ResourceTask:         true,
	access.ResourceMilestone:    true,
	access.ResourceAssignment:   true,
	access.ResourceResource:     false,
	access.ResourceWorker:       false,
	access.ResourceState:        false,
	access.ResourceComment:      false,
	access.ResourceUserCatalog:  false,
	access.ResourceRBACConfig:   false,
	access.ResourceUserAdmin:    false,
	access.ResourceStateAdmin:   false,
	access.ResourceOrgStructure: false,
	access.ResourceAudit:        false,
	access.ResourceAutoCreate:   false,
}

//nolint:gochecknoglobals // derived applicability tables
var ownerDescendants = map[access.Resource][]access.Resource{
	access.ResourceProject:      {access.ResourceProcess, access.ResourceTask},
	access.ResourceProcess:      {access.ResourceTask},
	access.ResourceTask:         {access.ResourceTask}, // subtasks
	access.ResourceMilestone:    nil,
	access.ResourceAssignment:   nil,
	access.ResourceResource:     nil,
	access.ResourceWorker:       nil,
	access.ResourceState:        nil,
	access.ResourceComment:      nil,
	access.ResourceUserCatalog:  nil,
	access.ResourceRBACConfig:   nil,
	access.ResourceUserAdmin:    nil,
	access.ResourceStateAdmin:   nil,
	access.ResourceOrgStructure: nil,
	access.ResourceAudit:        nil,
	access.ResourceAutoCreate:   nil,
}
