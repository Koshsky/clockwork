/**
 * Russian catalog — timesheet grid and cell plus the timesheet page.
 */
export default {
  /** TimesheetPage.vue */
  page: {
    dayTypes: 'Виды дней',
    title: 'Табель',
    /** Visibility note: the viewer sees every employee (worker.view scope all) */
    allEmployees: 'Все сотрудники',
    searchPlaceholder: 'Поиск по ФИО или должности',
    managerAll: 'Все руководители',
    managerNone: 'Без руководителя',
    resourceAll: 'Все ресурсы',
    resourceNone: 'Без ресурса',
    resourceFilterTitle: 'Фильтр по ресурсу',
    emptyFiltered: 'Ничего не найдено',
    emptyRoster: 'Нет данных о сотрудниках',
    more: 'Показать ещё ({shown} из {total})',
  },
  /** TimesheetCell.vue */
  cell: {
    weekend: 'Выходной',
    workday: 'Рабочий день',
    selection: 'Выделенный фрагмент',
  },
  /** TimesheetGrid.vue — the floating panel for assigning a state */
  panel: {
    ariaLabel: 'Назначить состояние',
    close: 'Закрыть',
    clear: 'Сбросить',
  },
} as const
