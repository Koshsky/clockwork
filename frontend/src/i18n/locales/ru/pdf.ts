/**
 * Russian catalog — PDF export (renderer, preview, dialog).
 */
export default {
  render: {
    page: 'Страница {page} из {total}',
  },
  preview: {
    openTimeout: 'Не удалось открыть документ для предпросмотра (таймаут)',
    renderTimeout: 'Не удалось отрисовать предпросмотр (таймаут)',
  },
  dialog: {
    defaultPageTitle: 'Диаграмма задач',
    openButton: 'Сохранить в PDF / Печать',
    title: 'Печать диаграммы в PDF',
    ariaTitle: 'Печать диаграммы в PDF',
    style: 'Стиль диаграммы',
    styleColor: 'Цветной',
    styleMono: 'Чёрно-белый',
    captureError: 'Не удалось сохранить вид диаграммы. Закройте окно печати и попробуйте снова.',
    barThickness: 'Толщина баров',
    onlyMine: 'Только мои процессы',
    onlyMineHint: 'Скрыть из печати процессы других владельцев',
    showMilestones: 'Показывать вехи',
    showTodayLine: 'Показывать линию «сегодня»',
    showTodayLineHint: 'Вертикальная линия текущей даты на диаграмме',
    showResources: 'Показывать занятость ресурсов',
    processes: 'Процессы',
    hideProjects: 'Скрыть проекты',
    projectFallback: 'Проект {id}',
    noProjects: 'Нет проектов',
    printPeriod: 'Период печати',
    periodFromData: 'Период определён по данным — уточните вид страницы',
    file: 'Файл',
    periodFallbackHint:
      'Период со страницы не определён — используется диапазон данных. Измените вид страницы и откройте заново.',
    truncatedHint:
      'Период шире, чем помещается на страницу: напечатана только его начальная часть. Сузьте период на странице.',
    pages: 'Страниц: {count}',
    updating: 'Обновляем…',
    preparing: 'Готовим предпросмотр…',
    empty: 'Нет данных для печати — измените фильтры',
    print: 'Печать',
    download: 'Скачать PDF',
  },
} as const
