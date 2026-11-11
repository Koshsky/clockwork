/**
 * Russian catalog — shared UI chrome of reusable components (data table, hint
 * panel, copy/color/password fields, usage badges). Screen-specific copy lives
 * in the area catalogs (adminUsers, adminConfig, adminSystem, planner, …).
 */
export default {
  color: {
    label: 'Цвет',
    titleChange: '{value} — изменить цвет',
    titleEmpty: 'Без цвета — выбрать цвет',
    ariaWithLabel: 'Цвет — {label}',
    ariaSwatch: 'Цвет {value}',
    none: 'Без цвета',
    paletteTitle: 'Гибкая палитра',
    paletteOpen: 'Открыть гибкую палитру',
  },
  dataTable: {
    resizeColumn: 'Изменить ширину колонки',
  },
  hint: {
    aria: 'Подсказка: {label}',
    close: 'Закрыть подсказку',
  },
  password: {
    minLength: 'от 8 до 64 символов',
    letter: 'минимум одна буква',
    digit: 'минимум одна цифра',
    dialogShownOnce: 'Пароль показывается один раз. Скопируйте его и передайте пользователю.',
    show: 'Показать пароль',
    hide: 'Скрыть пароль',
  },
  pending: {
    title: 'Изменение ожидает отправки на сервер',
  },
  states: {
    loading: 'Загрузка...',
  },
  resource: {
    total: 'Всего: {count}',
  },
  usage: {
    normal: 'Норма',
    warn: 'Перегруз',
    critical: 'Критично',
    weekend: 'Выходной',
    absencesTitle: 'Отсутствуют:',
  },
} as const
