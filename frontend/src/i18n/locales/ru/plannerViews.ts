/**
 * Russian catalog — planner, projects and processes pages (with the planning-origin helper).
 */
export default {
  /** Timeline scale units of the planning pages (right-click on the table header) */
  unit: {
    day: 'День',
    week: 'Неделя',
  },
  /** PDF export page title of each planning page */
  pdf: {
    tasks: 'Диаграмма задач',
    projects: 'Диаграмма проектов',
    processes: 'Диаграмма процессов',
  },
  offline: {
    disabled: 'Недоступно в офлайне',
  },
  // --- PlannerPage.vue (tasks diagram) ---
  planner: {
    viewAs: 'Владелец ресурсов',
    wholeSystem: 'Все ресурсы',
    /** Right-click menu on a task bar / a milestone flag / an empty group area */
    menu: {
      comments: 'Комментарии',
      editTask: 'Редактировать',
      manageResources: 'Управление ресурсами',
      deleteTask: 'Удалить задачу',
      editMilestone: 'Редактировать',
      deleteMilestone: 'Удалить веху',
      createTask: 'Создать задачу',
      createMilestone: 'Создать веху',
    },
    milestone: {
      title: 'Редактировать веху',
      field: {
        title: 'Название',
        color: 'Цвет',
        content: 'Контент',
      },
      /** Server-side names of a newly created record — translated at creation time */
      defaultTitle: 'Новая веха',
    },
    task: {
      defaultTitle: 'Новая задача',
    },
    confirm: {
      deleteTask: 'Удалить задачу?',
      deleteMilestone: 'Удалить веху?',
      deleteComment: 'Удалить комментарий? Ответы останутся.',
    },
  },
  // --- ProjectsPage.vue ---
  projects: {
    menu: {
      edit: 'Редактировать',
      delete: 'Удалить проект',
      create: 'Создать проект',
    },
    /** Code of a project created from the diagram: "КО_" + timestamp */
    defaultCodePrefix: 'КО_',
    edit: 'Редактировать проект',
    field: {
      code: 'Код проекта',
      color: 'Цвет',
      owner: 'Владелец',
      startDate: 'Дата начала',
      endDate: 'Дата завершения',
      duration: 'Длительность: {days} дн.',
      responsible: 'Ответственный',
      responsibleHint: 'руководитель группы',
      noResponsible: '— не выбран —',
    },
    /** Code of the print model group of the projects diagram */
    pdfGroup: 'Проекты',
    confirm: {
      delete: 'Удалить проект? Это удалит все его процессы, задачи и вехи.',
    },
    /** Feedback after a project was created by the auto-create template */
    autoCreated: 'Проект создан. По шаблону автосоздания добавлено: процессов — {processes}, задач — {tasks}, назначений ресурсов — {assignments}',
  },
  // --- ProcessesPage.vue ---
  processes: {
    menu: {
      create: 'Создать процесс',
      edit: 'Редактировать',
      delete: 'Удалить процесс',
    },
    edit: 'Редактировать процесс',
    field: {
      title: 'Название',
      color: 'Цвет',
      startDate: 'Дата начала',
      endDate: 'Дата завершения',
      duration: 'Длительность: {days} дн.',
      owner: 'Владелец',
      responsible: 'Ответственный',
      responsibleHint: 'руководитель группы',
      noResponsible: '— не выбран —',
    },
    /** Server-side name of a newly created record — translated at creation time */
    defaultTitle: 'Новый процесс',
    confirm: {
      delete: 'Удалить процесс? Это удалит все его задачи и вехи.',
    },
  },
} as const
