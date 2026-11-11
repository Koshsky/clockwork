import type ru from '../ru/plannerViews'
import type { Translation } from '../types'

/** English catalog mirroring locales/ru/plannerViews.ts. */
export default {
  unit: {
    day: 'Day',
    week: 'Week',
  },
  pdf: {
    tasks: 'Task chart',
    projects: 'Project chart',
    processes: 'Process chart',
  },
  offline: {
    disabled: 'Unavailable offline',
  },
  planner: {
    viewAs: 'Resource owner',
    wholeSystem: 'All resources',
    menu: {
      comments: 'Comments',
      editTask: 'Edit',
      manageResources: 'Manage resources',
      deleteTask: 'Delete task',
      editMilestone: 'Edit',
      deleteMilestone: 'Delete milestone',
      createTask: 'Create task',
      createMilestone: 'Create milestone',
    },
    milestone: {
      title: 'Edit milestone',
      field: {
        title: 'Name',
        color: 'Color',
        content: 'Content',
      },
      defaultTitle: 'New milestone',
    },
    task: {
      defaultTitle: 'New task',
    },
    confirm: {
      deleteTask: 'Delete the task?',
      deleteMilestone: 'Delete the milestone?',
      deleteComment: 'Delete the comment? Replies will remain.',
    },
  },
  projects: {
    menu: {
      edit: 'Edit',
      delete: 'Delete project',
      create: 'Create project',
    },
    defaultCodePrefix: 'PRJ_',
    edit: 'Edit project',
    field: {
      code: 'Project code',
      color: 'Color',
      owner: 'Owner',
      startDate: 'Start date',
      endDate: 'End date',
      duration: 'Duration: {days} days',
      responsible: 'Responsible',
      responsibleHint: 'group lead',
      noResponsible: '— none —',
    },
    pdfGroup: 'Projects',
    confirm: {
      delete: 'Delete the project? This deletes all its processes, tasks and milestones.',
    },
    autoCreated: 'Project created. The auto-create template added: processes — {processes}, tasks — {tasks}, resource assignments — {assignments}',
  },
  processes: {
    menu: {
      create: 'Create process',
      edit: 'Edit',
      delete: 'Delete process',
    },
    edit: 'Edit process',
    field: {
      title: 'Name',
      color: 'Color',
      startDate: 'Start date',
      endDate: 'End date',
      duration: 'Duration: {days} days',
      owner: 'Owner',
      responsible: 'Responsible',
      responsibleHint: 'group lead',
      noResponsible: '— none —',
    },
    defaultTitle: 'New process',
    confirm: {
      delete: 'Delete the process? This deletes all its tasks and milestones.',
    },
  },
} satisfies Translation<typeof ru>
