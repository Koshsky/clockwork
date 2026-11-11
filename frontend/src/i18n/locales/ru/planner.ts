/**
 * Russian catalog — planner components (bar, gantt, milestone, task editor,
 * comments, resource manager) and the scheduling-dependency engine labels.
 */
export default {
  bar: {
    /**
     * Accessible name of a draggable bar (role="slider"): the caller passes the
     * title already wrapped in «» (or the fallback word), plus the date range.
     */
    taskNamed: 'Задача {title}: {range}',
    /** Accessible name of a task bar without a range (the surrounding slider exposes it) */
    taskQuoted: 'Задача «{title}»',
    task: 'Задача',
    milestoneNamed: 'Веха «{title}»: {date}',
    milestone: 'Веха: {date}',
    priority: 'Приоритет: {value}',
    owner: 'Владелец: {owner}',
    responsible: 'Ответственный: {name}',
  },
  taskBar: {
    owner: 'Владелец: {owner}',
    responsible: 'Ответственный: {name}',
    status: 'Статус: {status}',
    progress: 'Выполнение: {value}% ({done} из {total} операций)',
    comments: 'Комментарии: {count}',
    userFallback: 'Пользователь #{id}',
  },
  taskStatus: {
    notStarted: 'Не начата',
    inProgress: 'В работе',
    done: 'Завершена',
  },
  calendar: {
    cornerToday: 'Сегодня',
  },
  workspace: {
    quantity: 'Количество',
    details: 'Основное',
    subtasks: 'Подзадачи',
    resources: 'Ресурсы',
    discussion: 'Обсуждение',
    sections: 'Разделы задачи',
    saveTask: 'Сохранить задачу',
    unsaved: 'Есть несохранённые изменения',
    independentActions: 'Ресурсы и комментарии сохраняются отдельно',
    unsavedTitle: 'Закрыть карточку задачи?',
    unsavedBody: 'В карточке есть несохранённые изменения или неотправленный текст. При закрытии они будут потеряны.',
    continueEditing: 'Продолжить редактирование',
    discard: 'Закрыть без сохранения',
    saveAndClose: 'Сохранить и закрыть',
    saveFailed: 'Не удалось сохранить. Введённые данные сохранены в карточке — попробуйте ещё раз.',
  },
  taskEditor: {
    titleNamed: 'Задача: {title}',
    title: 'Задача',
    field: {
      name: 'Название',
      namePlaceholder: 'Название задачи',
      status: 'Статус',
      owner: 'Владелец',
      ownerNone: '— не выбран —',
      responsible: 'Ответственный',
      responsibleNone: '— не выбран —',
      color: 'Цвет',
      colorLabel: 'Цвет задачи',
    },
    readonly: 'Нет права на изменение задачи — режим просмотра',
    subtasksTitle: 'Операции',
    subtaskStatusHint: 'Статус: {status} (нажмите, чтобы изменить)',
    subtask: {
      empty: 'Операций нет',
      newPlaceholder: 'Новая операция…',
      deleteAria: 'Удалить операцию {title}',
    },
    dependenciesTitle: 'Зависимости',
    dependency: {
      empty: 'Зависимостей нет',
      typeAria: 'Тип связи с «{title}»',
      deleteAria: 'Удалить связь с «{title}»',
      predecessorAria: 'Задача-предшественник',
      predecessorNone: '— предшественник —',
      typeAriaShort: 'Тип связи',
    },
    dependencyNote: 'При добавлении или изменении связи даты задач корректируются автоматически.',
    /** Storybook Controls metadata for the task editor (docs-only) */
    argTypes: {
      open: { name: 'Открыто', description: 'Показывать модальное окно' },
      task: { name: 'Задача', description: 'Редактируемая задача (левая панель)' },
      subtasks: { name: 'Подзадачи', description: 'Список подзадач (правая панель, todo list)' },
      ownerOptions: {
        name: 'Ответственные',
        description: 'Кандидаты на роль ответственного (свои сотрудники)',
      },
      canManage: { name: 'Может управлять', description: 'Разрешено менять поля задачи и подзадачи' },
      canCreateSubtask: {
        name: 'Может добавлять подзадачи',
        description: 'Разрешено создавать подзадачи',
      },
      busy: { name: 'Запрос', description: 'Идёт запрос к API — действия заблокированы' },
      error: { name: 'Ошибка', description: 'Сообщение об ошибке внутри окна' },
      disabledReason: {
        name: 'Причина блокировки',
        description: 'Пояснение, почему подзадачи недоступны (например, офлайн)',
      },
    },
  },
  taskComments: {
    titleNamed: 'Комментарии: {title}',
    titleFallback: 'Комментарии: Задача #{id}',
    loading: 'Загрузка комментариев…',
    empty: 'Комментариев пока нет',
    orphan: 'в ответ на удалённый комментарий',
    orphanTitle: 'Родительский комментарий удалён',
    reply: 'Ответить',
    deleteTitle: 'Удалить комментарий',
    replyPlaceholder: 'Ответ…',
    send: 'Отправить',
    composerPlaceholder: 'Написать комментарий…',
    userFallback: 'Пользователь #{id}',
  },
  resourceModal: {
    title: 'Ресурсы задачи: {title}',
    removeAria: 'Убрать ресурс',
    empty: 'Ресурсы не назначены',
    selectPlaceholder: '— выберите ресурс —',
    /** Fallback of a catalogue row without a name and of its select option */
    itemFallback: 'Ресурс #{id}',
  },
  projectPlanning: {
    create: 'Новый проект',
  },
  scaleBadge: {
    label: 'Масштаб ',
  },
  dependencies: {
    fs: 'Окончание → Начало',
    ss: 'Начало → Начало',
    ff: 'Окончание → Окончание',
    sf: 'Начало → Окончание',
  },
} as const
