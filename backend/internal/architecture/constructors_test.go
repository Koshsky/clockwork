package architecture_test

import (
	"reflect"
	"testing"

	auth "github.com/Koshsky/erp-backend/internal/auth/service"
	authz "github.com/Koshsky/erp-backend/internal/authz/service"
	autocreate "github.com/Koshsky/erp-backend/internal/auto_create/service"
	planning "github.com/Koshsky/erp-backend/internal/planning/service"
	assignment "github.com/Koshsky/erp-backend/internal/project_mgmt/assignment/service"
	comment "github.com/Koshsky/erp-backend/internal/project_mgmt/comment/service"
	milestone "github.com/Koshsky/erp-backend/internal/project_mgmt/milestone"
	process "github.com/Koshsky/erp-backend/internal/project_mgmt/process/service"
	project "github.com/Koshsky/erp-backend/internal/project_mgmt/project/service"
	task "github.com/Koshsky/erp-backend/internal/project_mgmt/task/service"
	dependency "github.com/Koshsky/erp-backend/internal/project_mgmt/task_dependency/service"
	calendar "github.com/Koshsky/erp-backend/internal/timesheet/calendar/service"
	resource "github.com/Koshsky/erp-backend/internal/timesheet/resource/service"
	state "github.com/Koshsky/erp-backend/internal/timesheet/state/service"
	user "github.com/Koshsky/erp-backend/internal/user/service"
)

func TestServiceConstructorsAcceptInterfacesAndReturnStructs(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name        string
		constructor any
		ports       []int
	}{
		{"auth", auth.NewAuthService, []int{1, 3}},
		{"policy store", authz.NewPolicyStore, []int{1, 2}},
		{"policy administration", authz.NewRBACService, []int{1, 3}},
		{"auto create", autocreate.NewAutoCreateService, []int{2}},
		{"planning", planning.NewPlanningService, []int{2}},
		{"assignment", assignment.NewAssignmentService, []int{2}},
		{"comment", comment.NewCommentService, []int{2}},
		{"milestone", milestone.NewService, []int{2}},
		{"process", process.NewProcessService, []int{2}},
		{"project", project.NewProjectService, []int{2}},
		{"task", task.NewTaskService, []int{2, 3}},
		{"dependency", dependency.NewTaskDependencyService, []int{2}},
		{"calendar", calendar.NewCalendarService, []int{2}},
		{"resource", resource.NewResourceService, []int{2}},
		{"state", state.NewStateService, []int{2}},
		{"user", user.NewUserService, []int{2, 3, 4}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			constructor := reflect.TypeOf(tc.constructor)
			for _, index := range tc.ports {
				if parameter := constructor.In(index); parameter.Kind() != reflect.Interface {
					t.Errorf("dependency %d requires a concrete implementation: %v", index, parameter)
				}
			}
			if constructor.NumOut() != 1 || constructor.Out(0).Kind() != reflect.Pointer ||
				constructor.Out(0).Elem().Kind() != reflect.Struct {
				t.Fatal("constructor no longer returns its concrete service")
			}
		})
	}
}
