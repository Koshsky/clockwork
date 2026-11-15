package server

import (
	autocreateDelivery "github.com/Koshsky/erp-backend/internal/auto_create/delivery"
	autocreateService "github.com/Koshsky/erp-backend/internal/auto_create/service"
	assignmentService "github.com/Koshsky/erp-backend/internal/project_mgmt/assignment"
	assignmentDelivery "github.com/Koshsky/erp-backend/internal/project_mgmt/assignment/delivery"
	milestoneService "github.com/Koshsky/erp-backend/internal/project_mgmt/milestone"
	milestoneDelivery "github.com/Koshsky/erp-backend/internal/project_mgmt/milestone/delivery"
	processDelivery "github.com/Koshsky/erp-backend/internal/project_mgmt/process/delivery"
	processService "github.com/Koshsky/erp-backend/internal/project_mgmt/process/service"
	projectDelivery "github.com/Koshsky/erp-backend/internal/project_mgmt/project/delivery"
	projectService "github.com/Koshsky/erp-backend/internal/project_mgmt/project/service"
	taskDelivery "github.com/Koshsky/erp-backend/internal/project_mgmt/task/delivery"
	taskService "github.com/Koshsky/erp-backend/internal/project_mgmt/task/service"
	calendarDelivery "github.com/Koshsky/erp-backend/internal/timesheet/calendar/delivery"
	calendarService "github.com/Koshsky/erp-backend/internal/timesheet/calendar/service"
	resourceDelivery "github.com/Koshsky/erp-backend/internal/timesheet/resource/delivery"
	resourceService "github.com/Koshsky/erp-backend/internal/timesheet/resource/service"
	stateService "github.com/Koshsky/erp-backend/internal/timesheet/state"
	stateDelivery "github.com/Koshsky/erp-backend/internal/timesheet/state/delivery"
	userDelivery "github.com/Koshsky/erp-backend/internal/user/delivery"
	userService "github.com/Koshsky/erp-backend/internal/user/service"
)

type (
	AutoCreateService = autocreateDelivery.AutoCreateService
	UserService       = userDelivery.UserService
	TaskService       = taskDelivery.TaskService
	ResourceService   = resourceDelivery.ResourceService
	ProjectService    = projectDelivery.ProjectService
	ProcessService    = processDelivery.ProcessService
	MilestoneService  = milestoneDelivery.MilestoneService
	AssignmentService = assignmentDelivery.AssignmentService
	StateService      = stateDelivery.StateService
	CalendarService   = calendarDelivery.CalendarService
)

// COMPILATION CHECK.
var (
	_ AutoCreateService = (*autocreateService.AutoCreateService)(nil)
	_ UserService       = (*userService.UserService)(nil)
	_ TaskService       = (*taskService.TaskService)(nil)
	_ ResourceService   = (*resourceService.ResourceService)(nil)
	_ ProjectService    = (*projectService.ProjectService)(nil)
	_ ProcessService    = (*processService.ProcessService)(nil)
	_ MilestoneService  = (*milestoneService.Service)(nil)
	_ AssignmentService = (*assignmentService.Service)(nil)
	_ StateService      = (*stateService.Service)(nil)
	_ CalendarService   = (*calendarService.CalendarService)(nil)
)
