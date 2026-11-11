package service

import (
	"context"

	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	"github.com/Koshsky/erp-backend/internal/planning/dto"
	"github.com/Koshsky/erp-backend/internal/planning/repository/sqlc"
)

// getSlice returns the slice associated with the given key in the map.
func getSlice[T any](m map[int64][]T, key int64) []T {
	if val, exists := m[key]; exists {
		return val
	}
	return []T{}
}

// loadProcesses loads processes for the given user ID and view scope code
// using the TASK scope semantics (parent = "in my processes"): the caller is
// the task-planning aggregate, and the same process list is what a process
// owner (vp) must see on the task diagram. The process aggregate uses the
// process scope directly (parent = "in my projects").
func (s *PlanningService) loadProcesses(
	ctx context.Context,
	userID int64,
	scope rbac.ListScope,
) ([]dto.Process, error) {
	rows, err := s.repository.ListProcessesByTaskScope(ctx, userID, scope)
	if err != nil {
		return nil, err
	}
	processes := make([]dto.Process, len(rows))
	for i, row := range rows {
		processes[i] = toTaskScopeProcess(row)
	}
	return processes, nil
}

// loadAllData load milestones, tasks, assignments, resources, comment counts
// and scheduling links for the given processes. Resources are scoped by the
// caller's resource view zone (userID/resourceScope); an empty zone (no
// resource view rule) includes all resources so the visible tasks still render
// their rows.
func (s *PlanningService) loadAllData(
	ctx context.Context,
	processes []dto.Process,
	userID int64,
	resourceScope rbac.ListScope,
	taskScope rbac.ListScope,
) (map[int64][]dto.Milestone, map[int64][]dto.Task, map[int64][]dto.Assignment, map[int64]dto.Resource, map[int64]int64, map[int64][]dto.TaskDependency, error) {
	processIDs := make([]int64, len(processes))
	for i, p := range processes {
		processIDs[i] = p.ID
	}

	milestoneRows, err := s.repository.ListMilestonesByProcessIDs(ctx, processIDs)
	if err != nil {
		return nil, nil, nil, nil, nil, nil, err
	}
	milestones := groupByKey(milestoneRows, func(m sqlc.Milestone) int64 { return m.ProcessID })
	milestoneDTOs := make(map[int64][]dto.Milestone, len(milestones))
	for processID, rows := range milestones {
		items := make([]dto.Milestone, len(rows))
		for i, row := range rows {
			items[i] = toMilestone(row)
		}
		milestoneDTOs[processID] = items
	}

	taskRows, err := s.repository.ListTasksByProcessIDs(ctx, processIDs, userID, taskScope)
	if err != nil {
		return nil, nil, nil, nil, nil, nil, err
	}
	taskDTOs, taskProcess := taskDTOsByProcess(taskRows)

	taskIDs := s.collectTaskIDs(taskDTOs)

	assignmentRows, err := s.repository.ListAssignmentsByTaskIDs(ctx, taskIDs)
	if err != nil {
		return nil, nil, nil, nil, nil, nil, err
	}
	assignments := groupByKey(assignmentRows, func(a sqlc.Assignment) int64 { return a.TaskID })
	assignmentDTOs := make(map[int64][]dto.Assignment, len(assignments))
	for taskID, rows := range assignments {
		items := make([]dto.Assignment, len(rows))
		for i, row := range rows {
			items[i] = toAssignment(row)
		}
		assignmentDTOs[taskID] = items
	}

	commentCounts, err := s.repository.ListTaskCommentCountsByTaskIDs(ctx, taskIDs)
	if err != nil {
		return nil, nil, nil, nil, nil, nil, err
	}

	// Scheduling links grouped by the process of their successor task (both
	// ends are same-process by construction).
	depRows, err := s.repository.ListTaskDependenciesByProcessIDs(ctx, processIDs)
	if err != nil {
		return nil, nil, nil, nil, nil, nil, err
	}
	dependencyDTOs := groupTaskDependencies(depRows, taskProcess)

	resourceRows, err := s.repository.ListResources(ctx, userID, resourceScope)
	if err != nil {
		return nil, nil, nil, nil, nil, nil, err
	}
	resources := make([]dto.Resource, len(resourceRows))
	for i, row := range resourceRows {
		resources[i] = toResource(row)
	}
	resourcesMap := s.buildResourceMap(resources)

	return milestoneDTOs, taskDTOs, assignmentDTOs, resourcesMap, commentCounts, dependencyDTOs, nil
}

// collectTaskIDs collects all task IDs from the tasks map.
func (s *PlanningService) collectTaskIDs(tasks map[int64][]dto.Task) []int64 {
	taskIDs := make([]int64, 0)
	for _, taskList := range tasks {
		for _, task := range taskList {
			taskIDs = append(taskIDs, task.ID)
		}
	}
	return taskIDs
}

// buildResourceMap creates a map of resources by their IDs.
func (s *PlanningService) buildResourceMap(resources []dto.Resource) map[int64]dto.Resource {
	resourceMap := make(map[int64]dto.Resource, len(resources))
	for _, res := range resources {
		resourceMap[res.ID] = res
	}
	return resourceMap
}

// taskDTOsByProcess builds the task DTOs grouped by process and the
// task→process lookup (both feeds of the planning aggregate).
func taskDTOsByProcess(rows []sqlc.Task) (map[int64][]dto.Task, map[int64]int64) {
	grouped := groupByKey(rows, func(t sqlc.Task) int64 { return t.ProcessID })
	taskDTOs := make(map[int64][]dto.Task, len(grouped))
	taskProcess := make(map[int64]int64)
	for processID, items := range grouped {
		dtos := make([]dto.Task, len(items))
		for i, row := range items {
			dtos[i] = toTask(row)
			taskProcess[row.ID] = processID
		}
		taskDTOs[processID] = dtos
	}
	return taskDTOs, taskProcess
}

// groupTaskDependencies groups scheduling links by the process of their
// successor task (both ends are same-process by construction); rows whose
// successor is not among the loaded tasks are skipped.
func groupTaskDependencies(
	rows []sqlc.ListTaskDependenciesByProcessIDsRow,
	taskProcess map[int64]int64,
) map[int64][]dto.TaskDependency {
	grouped := make(map[int64][]dto.TaskDependency)
	for _, row := range rows {
		processID, ok := taskProcess[row.TaskDependency.TaskID]
		if !ok {
			continue
		}
		grouped[processID] = append(grouped[processID], toTaskDependency(row.TaskDependency))
	}
	return grouped
}

// buildPlanning constructs the final task planning structure.
func (s *PlanningService) buildPlanning(
	processes []dto.Process,
	milestones map[int64][]dto.Milestone,
	tasks map[int64][]dto.Task,
	assignments map[int64][]dto.Assignment,
	resourcesMap map[int64]dto.Resource,
	commentCounts map[int64]int64,
	dependencies map[int64][]dto.TaskDependency,
) *dto.TaskPlanning {
	planning := &dto.TaskPlanning{
		Processes: make([]dto.DetailedProcess, 0, len(processes)),
	}

	for _, process := range processes {
		detailedProcess := s.buildDetailedProcess(
			process,
			milestones,
			tasks,
			assignments,
			resourcesMap,
			commentCounts,
			dependencies,
		)
		planning.Processes = append(planning.Processes, detailedProcess)
	}

	return planning
}

// buildDetailedProcess constructs a detailed process with its tasks and milestones.
func (s *PlanningService) buildDetailedProcess(
	process dto.Process,
	milestones map[int64][]dto.Milestone,
	tasks map[int64][]dto.Task,
	assignments map[int64][]dto.Assignment,
	resourcesMap map[int64]dto.Resource,
	commentCounts map[int64]int64,
	dependencies map[int64][]dto.TaskDependency,
) dto.DetailedProcess {
	// Use the generic getSlice function
	processTasks := getSlice(tasks, process.ID)
	processMilestones := getSlice(milestones, process.ID)
	detailedTasks := s.buildDetailedTasks(processTasks, assignments, resourcesMap, commentCounts)

	return dto.DetailedProcess{
		Process:      process,
		Milestones:   processMilestones,
		Dependencies: getSlice(dependencies, process.ID),
		Tasks:        detailedTasks,
	}
}

// buildDetailedTasks constructs detailed tasks with their resources, nesting
// subtasks (operations) under their parent task: only top-level tasks appear
// in the returned slice, each carrying its subtasks in display order.
func (s *PlanningService) buildDetailedTasks(
	tasks []dto.Task,
	assignments map[int64][]dto.Assignment,
	resourcesMap map[int64]dto.Resource,
	commentCounts map[int64]int64,
) []dto.DetailedTask {
	// Build every detailed task first, then group subtasks by parent.
	detailed := make([]dto.DetailedTask, 0, len(tasks))
	byParent := make(map[int64][]dto.DetailedTask, len(tasks))
	for _, task := range tasks {
		taskAssignments := getSlice(assignments, task.ID)
		resources := s.buildTaskResources(taskAssignments, resourcesMap)

		item := dto.DetailedTask{
			Task:          task,
			Resources:     resources,
			CommentsCount: commentCounts[task.ID],
		}
		if task.ParentID != nil {
			byParent[*task.ParentID] = append(byParent[*task.ParentID], item)
			continue
		}
		detailed = append(detailed, item)
	}

	// Attach children to their parents (input is already sorted by the
	// repository, so appended children keep their display order).
	for i := range detailed {
		if children := byParent[detailed[i].ID]; len(children) > 0 {
			detailed[i].Subtasks = children
		}
	}

	return detailed
}

// buildTaskResources constructs resources for a task.
func (s *PlanningService) buildTaskResources(
	assignments []dto.Assignment,
	resourcesMap map[int64]dto.Resource,
) []dto.Resource {
	resources := make([]dto.Resource, 0, len(assignments))

	for _, assignment := range assignments {
		res, exists := resourcesMap[assignment.ResourceID]
		if !exists {
			continue
		}

		resources = append(resources, dto.Resource{
			ID:           assignment.ResourceID,
			Title:        res.Title,
			Code:         res.Code,
			Color:        res.Color,
			Quantity:     assignment.Quantity,
			AssignmentID: assignment.ID,
		})
	}

	return resources
}
