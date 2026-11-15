package rbac_test

import (
	"testing"

	"github.com/Koshsky/erp-backend/internal/authz/engine"
	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
)

// Kind validation: valid ones are built, invalid ones are an error.
func TestValidateSpec(t *testing.T) {
	t.Parallel()
	valid := []engine.RouteSpec{
		{Name: "b.list", Kind: "list", Params: map[string]any{"resource": "project", "query_key": "owner_id"}},
		{
			Name:   "b.view",
			Kind:   "entity",
			Params: map[string]any{"resource": "project", "action": "view", "owner": "id"},
		},
		{
			Name:   "b.view.none",
			Kind:   "entity",
			Params: map[string]any{"resource": "state", "action": "view", "owner": "none"},
		},
		{
			Name:   "b.create",
			Kind:   "create",
			Params: map[string]any{"resource": "task", "parent_resource": "process", "parent_from": "process_id"},
		},
		{
			Name:   "b.create.self",
			Kind:   "create",
			Params: map[string]any{"resource": "worker", "owner_key": "manager_id", "default_self": true},
		},
		{Name: "b.owner.match", Kind: "owner_match", Params: map[string]any{
			"resource": "assignment", "primary_resource": "task", "primary_from": "task_id",
			"compare_resource": "resource", "compare_from": "resource_id", "exempt_roles": []any{"admin"},
		}},
		{Name: "b.author.or", Kind: "author_or", Params: map[string]any{
			"author_resource": "comment", "author_id_param": "comment_id",
			"right_resource": "task", "right_action": "update",
		}},
		{
			Name: "b.task.order",
			Kind: "parent_action",
			Params: map[string]any{
				"resource":        "task",
				"action":          "update",
				"parent_resource": "process",
				"parent_from":     "process_id",
			},
		},
		{
			Name: "b.process.order",
			Kind: "parent_action",
			Params: map[string]any{
				"resource":        "process",
				"action":          "update",
				"parent_resource": "project",
				"parent_from":     "project_id",
			},
		},
	}
	for _, spec := range valid {
		if err := rbac.ValidateSpec(spec); err != nil {
			t.Errorf("ValidateSpec(%s) неожиданная ошибка: %v", spec.Name, err)
		}
	}

	invalid := []struct {
		name string
		spec engine.RouteSpec
	}{
		{"unknown kind", engine.RouteSpec{Name: "x", Kind: "wat", Params: map[string]any{}}},
		{
			"unknown resource",
			engine.RouteSpec{Name: "x", Kind: "entity", Params: map[string]any{"resource": "nope", "action": "view"}},
		},
		{
			"unknown action",
			engine.RouteSpec{
				Name:   "x",
				Kind:   "entity",
				Params: map[string]any{"resource": "project", "action": "edit"},
			},
		},
		{
			"list без query_key",
			engine.RouteSpec{Name: "x", Kind: "list", Params: map[string]any{"resource": "project"}},
		},
		{
			"create: parent_from без parent_resource",
			engine.RouteSpec{
				Name:   "x",
				Kind:   "create",
				Params: map[string]any{"resource": "task", "parent_from": "process_id"},
			},
		},
		{
			"create: ни parent_from ни owner_key",
			engine.RouteSpec{Name: "x", Kind: "create", Params: map[string]any{"resource": "task"}},
		},
		{"owner_match: неизвестный compare", engine.RouteSpec{Name: "x", Kind: "owner_match", Params: map[string]any{
			"resource": "assignment", "primary_resource": "task", "primary_from": "task_id",
			"compare_resource": "nope", "compare_from": "resource_id",
		}}},
		{"author_or: неизвестное право", engine.RouteSpec{Name: "x", Kind: "author_or", Params: map[string]any{
			"author_resource": "comment", "author_id_param": "comment_id",
			"right_resource": "task", "right_action": "edit",
		}}},
		{
			"parent_action: parent_from без parent_resource",
			engine.RouteSpec{Name: "x", Kind: "parent_action", Params: map[string]any{
				"resource": "task", "action": "update", "parent_from": "process_id",
			}},
		},
		{
			"parent_action: неизвестный родитель",
			engine.RouteSpec{Name: "x", Kind: "parent_action", Params: map[string]any{
				"resource": "task", "action": "update", "parent_resource": "nope", "parent_from": "process_id",
			}},
		},
		{
			"parent_action: неизвестное действие",
			engine.RouteSpec{Name: "x", Kind: "parent_action", Params: map[string]any{
				"resource": "task", "action": "edit", "parent_resource": "process", "parent_from": "process_id",
			}},
		},
		{
			"имя с пробелами",
			engine.RouteSpec{
				Name:   " x ",
				Kind:   "entity",
				Params: map[string]any{"resource": "project", "action": "view"},
			},
		},
		{
			"пустое имя",
			engine.RouteSpec{
				Name:   "",
				Kind:   "entity",
				Params: map[string]any{"resource": "project", "action": "view"},
			},
		},
		{
			"неверный тип параметра",
			engine.RouteSpec{
				Name:   "x",
				Kind:   "create",
				Params: map[string]any{"resource": 42, "owner_key": "owner_id"},
			},
		},
	}
	for _, tc := range invalid {
		if err := rbac.ValidateSpec(tc.spec); err == nil {
			t.Errorf("ValidateSpec(%s) должен дать ошибку", tc.name)
		}
	}

	// BuildPolicies: an invalid specification fails the whole build (fail-closed).
	built, err := rbac.BuildPolicies([]engine.RouteSpec{valid[0], invalid[1].spec})
	if err == nil || len(built) != 0 {
		t.Errorf("BuildPolicies с битой спецификацией: err=%v built=%d; want error и пусто", err, len(built))
	}
}

// The Kinds reference contains all kinds and parameter schemas.
func TestKinds(t *testing.T) {
	t.Parallel()
	infos := rbac.Kinds()
	if len(infos) != 7 {
		t.Fatalf("Kinds() = %d; want 7", len(infos))
	}
	seen := map[string]bool{}
	for _, k := range infos {
		seen[k.Name] = true
		if len(k.Params) == 0 {
			t.Errorf("kind %s без схемы параметров", k.Name)
		}
	}
	for _, name := range []string{"list", "entity", "create", "owner_match", "author_or", "parent_action", "any_capability"} {
		if !seen[name] {
			t.Errorf("в Kinds() нет kind'а %s", name)
		}
	}
}
