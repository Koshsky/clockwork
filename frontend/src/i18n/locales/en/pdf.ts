import type ru from '../ru/pdf'
import type { Translation } from '../types'

/** English catalog mirroring locales/ru/pdf.ts. */
export default {
  render: {
    page: 'Page {page} of {total}',
  },
  preview: {
    openTimeout: 'Could not open the document for preview (timeout)',
    renderTimeout: 'Could not render the preview (timeout)',
  },
  dialog: {
    defaultPageTitle: 'Task chart',
    openButton: 'Save to PDF / Print',
    title: 'Print chart to PDF',
    ariaTitle: 'Print chart to PDF',
    style: 'Chart style',
    styleColor: 'Color',
    styleMono: 'Black and white',
    captureError: 'Could not capture the diagram. Close the print dialog and try again.',
    barThickness: 'Bar thickness',
    onlyMine: 'Only my processes',
    onlyMineHint: 'Hide processes owned by other users from the print',
    showMilestones: 'Show milestones',
    showTodayLine: 'Show the "today" line',
    showTodayLineHint: 'Vertical line of the current date on the chart',
    showResources: 'Show resource load',
    processes: 'Processes',
    hideProjects: 'Hide projects',
    projectFallback: 'Project {id}',
    noProjects: 'No projects',
    printPeriod: 'Print period',
    periodFromData: 'The period was derived from the data — refine the page view',
    file: 'File',
    periodFallbackHint:
      'The period could not be resolved from the page — the data range is used. Change the page view and open the dialog again.',
    truncatedHint:
      'The period is wider than one page: only its beginning was printed. Narrow the period on the page.',
    pages: 'Pages: {count}',
    updating: 'Updating…',
    preparing: 'Preparing the preview…',
    empty: 'Nothing to print — change the filters',
    print: 'Print',
    download: 'Download PDF',
  },
} satisfies Translation<typeof ru>
