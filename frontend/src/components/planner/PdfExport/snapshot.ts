import type { PdfGanttGroup } from './pdfRenderer'

export interface DiagramSnapshot {
  frame: HTMLDivElement
  width: number
  height: number
  barThickness: number
  scale: number
  disposed: boolean
  dispose: () => void
}

export interface SnapshotOptions {
  cancelled?: () => boolean
  extent?: 'viewport' | 'selection'
  groups: PdfGanttGroup[]
  scope: 'tasks' | 'processes' | 'projects'
  showMilestones: boolean
  showTodayLine: boolean
  showResources: boolean
  style: 'color' | 'mono'
  barThickness: number
}

export interface SnapshotPrintPage {
  png: string
  width: number
  height: number
}

export interface SnapshotPdfResult {
  bytes: Uint8Array
  pages: SnapshotPrintPage[]
}

function copyStyles(source: Element, target: Element) {
  if (!(target instanceof HTMLElement || target instanceof SVGElement)) return
  const styles = getComputedStyle(source)
  for (const property of styles) target.style.setProperty(property, styles.getPropertyValue(property))
  target.style.animation = 'none'
  target.style.transition = 'none'
}

function zoomOf(element: Element, root: Element): number {
  let zoom = 1
  for (let current: Element | null = element; current && current !== root; current = current.parentElement) {
    zoom *= Number(getComputedStyle(current).zoom) || 1
  }
  return zoom
}

function backgroundOf(source: HTMLElement): string {
  for (let node: HTMLElement | null = source; node; node = node.parentElement) {
    const color = getComputedStyle(node).backgroundColor
    if (color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)') return color
  }
  return '#ffffff'
}

/** Freeze layout before opening the dialog; the live planner is never modified. */
export function freezeDiagram(source: HTMLElement, full = false): DiagramSnapshot {
  const width = source.clientWidth, height = source.clientHeight
  if (!width || !height) throw new Error('The diagram viewport is empty')
  const bounds = source.getBoundingClientRect()
  const frame = document.createElement('div')
  Object.assign(frame.style, { position: 'relative', width: `${width}px`, height: `${height}px`, overflow: 'hidden',
    background: backgroundOf(source), font: getComputedStyle(source).font })
  if (full) {
    const styles = getComputedStyle(source)
    for (const property of styles) if (property.startsWith('--')) frame.style.setProperty(property, styles.getPropertyValue(property))
    frame.style.color = styles.color
    frame.style.colorScheme = styles.colorScheme
  }
  const host = document.createElement('div')
  Object.assign(host.style, { position: 'fixed', left: '-100000px', top: '0', width: `${width}px`, pointerEvents: 'none' })
  host.setAttribute('aria-hidden', 'true')
  host.append(frame)
  const stickies: { source: Element; clone: HTMLElement; bounds: DOMRect; zoom: number }[] = []
  function clone(node: Node): Node | null {
    if (node.nodeType === Node.COMMENT_NODE) return null
    if (!(node instanceof Element)) return node.cloneNode()
    if (node.matches('.scale-badge, .sb, .gb-handle, .drop-line')) return null
    const rect = node.getBoundingClientRect()
    const offscreen = rect.bottom < bounds.top || rect.top > bounds.top + height
    if (!full && node.matches('.gg-group, .tg-task-group') && offscreen) {
      const spacer = node.cloneNode(false) as HTMLElement
      const group = node.matches('.gg-group') ? node : node.querySelector('.gg-group')
      const row = group?.querySelector('.gg-row')
      Object.assign(spacer.style, { position: 'relative', height: getComputedStyle(node).height,
        minHeight: '0', padding: '0', margin: '0', border: '0', boxSizing: 'border-box' })
      spacer.dataset.pdfPlaceholder = 'true'
      spacer.dataset.pdfRowHeight = row ? getComputedStyle(row).height : '26'
      spacer.dataset.pdfMinRows = (group as HTMLElement | null)?.dataset.pdfMinRows ?? '0'
      spacer.dataset.pdfMinHeight = (group as HTMLElement | null)?.dataset.pdfMinHeight ?? '0'
      spacer.dataset.pdfPadding = node.matches('.tg-task-group') ? getComputedStyle(node).paddingTop : '0'
      return spacer
    }
    const result = node.cloneNode(false) as Element
    if (!full || node instanceof SVGElement) copyStyles(node, result)
    if (full && node.matches('.tg-task-group') && result instanceof HTMLElement) result.style.paddingTop = getComputedStyle(node).paddingTop
    if (getComputedStyle(node).position === 'sticky' && result instanceof HTMLElement) {
      Object.assign(result.style, { position: 'relative', inset: 'auto' })
      stickies.push({ source: node, clone: result, bounds: rect, zoom: zoomOf(node, source) })
    }
    for (const child of node.childNodes) {
      const copy = clone(child)
      if (copy) result.append(copy)
    }
    return result
  }
  try {
    const content = source.querySelector<HTMLElement>('.tg-content')
    if (!content) throw new Error('The diagram content is missing')
    const copy = clone(content) as HTMLElement
    const zoom = Number(getComputedStyle(content).zoom) || 1
    copy.style.transform = `translate(${-source.scrollLeft / zoom}px, ${full ? 0 : -source.scrollTop / zoom}px)`
    copy.style.transformOrigin = '0 0'
    frame.append(copy)
    document.body.append(host)
    const origin = frame.getBoundingClientRect()
    for (const sticky of stickies) {
      const actual = sticky.clone.getBoundingClientRect()
      const dx = sticky.bounds.left - bounds.left - (actual.left - origin.left)
      const dy = full ? 0 : sticky.bounds.top - bounds.top - (actual.top - origin.top)
      sticky.clone.style.transform = `translate(${dx / sticky.zoom}px, ${dy / sticky.zoom}px)`
    }
    const firstBar = source.querySelector('.gantt-bar')
    const barThickness = firstBar ? parseFloat(getComputedStyle(firstBar).height) : 24
    const snapshot: DiagramSnapshot = { frame, width, height, barThickness, scale: zoom, disposed: false, dispose: () => { snapshot.disposed = true; host.remove() } }
    return snapshot
  } catch (error) {
    host.remove()
    throw error
  }
}

function updateRows(group: HTMLElement, thickness: number, originalThickness: number, resize: boolean) {
  const rows = [...group.querySelectorAll<HTMLElement>(':scope > .gg-row')]
  if (resize) {
    for (const row of rows) {
      const height = parseFloat(row.style.height) + thickness - originalThickness
      row.style.height = `${height}px`
      const bars = row.querySelector<HTMLElement>('.gg-bars')
      if (bars) bars.style.height = `${height}px`
      const label = row.querySelector<HTMLElement>(':scope > .gg-label')
      if (label) label.style.height = `${height}px`
    }
  }
  const minimum = Number(group.dataset.pdfMinHeight ?? 0)
  const total = rows.reduce((height, row) => height + parseFloat(row.style.height), 0)
  group.style.minHeight = `${Math.max(minimum, total)}px`
  group.style.height = group.style.minHeight
  const label = group.querySelector<HTMLElement>(':scope > .gg-merged')
  if (label) {
    label.style.height = group.style.minHeight
    label.style.marginBottom = `-${Math.max(minimum, total)}px`
  }
  if (group.parentElement?.classList.contains('tg-task-group')) {
    const parent = group.parentElement
    parent.style.height = `${Math.max(minimum, total) + parseFloat(parent.style.paddingTop)}px`
    const links = parent.querySelector<SVGElement>('.tdl-links')
    if (links && resize) {
      links.style.transformOrigin = '0 20px'
      links.style.transform = `scaleY(${(thickness + 2) / (originalThickness + 2)})`
    }
  }
}

function resizePlaceholder(element: HTMLElement, model: PdfGanttGroup, delta: number) {
  const rowHeight = parseFloat(element.dataset.pdfRowHeight ?? '26') + delta
  const count = Math.max(Number(element.dataset.pdfMinRows ?? 0), model.rows.length)
  const height = Math.max(Number(element.dataset.pdfMinHeight ?? 0), count * rowHeight)
    + parseFloat(element.dataset.pdfPadding ?? '0')
  element.style.height = `${height}px`
}

export function prepareSnapshot(snapshot: DiagramSnapshot, options: SnapshotOptions): HTMLDivElement {
  const frame = snapshot.frame.cloneNode(true) as HTMLDivElement
  const ids = new Map(options.groups.map((group) => [String(group.id), group]))
  const taskGroups = frame.querySelectorAll<HTMLElement>('.tg-task-group')
  if (options.scope === 'tasks') {
    for (const group of taskGroups) {
      const model = ids.get(group.dataset.pdfGroup ?? group.querySelector<HTMLElement>('.gg-group')?.dataset.group ?? '')
      if (!model) group.remove()
      else if (group.dataset.pdfPlaceholder && options.barThickness !== snapshot.barThickness) resizePlaceholder(group, model, options.barThickness - snapshot.barThickness)
    }
  }
  for (const group of frame.querySelectorAll<HTMLElement>('.gg-group')) {
    const model = options.scope === 'projects' ? options.groups[0] : ids.get(group.dataset.group ?? '')
    if (!model) { group.remove(); continue }
    if (group.dataset.pdfPlaceholder) {
      resizePlaceholder(group, model, options.barThickness - snapshot.barThickness)
      continue
    }
    const rows = new Set(model.rows.map((row) => String(row.id)))
    let filtered = false
    for (const row of group.querySelectorAll<HTMLElement>(':scope > .gg-row[data-pdf-row]')) {
      if (!rows.has(row.dataset.pdfRow ?? '')) { row.remove(); filtered = true }
    }
    const resize = options.barThickness !== snapshot.barThickness
    if (filtered || resize) updateRows(group, options.barThickness, snapshot.barThickness, resize)
  }
  const hidden = [!options.showMilestones && '.ms, .tg-ms-label', !options.showTodayLine && '.tl-line, .tl-band',
    !options.showResources && '.rs-labels, .rs-block'].filter(Boolean).join(', ')
  if (hidden) for (const element of frame.querySelectorAll(hidden)) element.remove()
  if (options.barThickness !== snapshot.barThickness) {
    for (const bar of frame.querySelectorAll<HTMLElement>('.gantt-bar')) bar.style.height = `${options.barThickness}px`
  }
  if (options.style === 'mono') frame.style.filter = 'grayscale(1)'
  return frame
}

export async function captureFrame(frame: HTMLElement, width: number, height: number, pixelRatio = 2): Promise<HTMLCanvasElement> {
  const { toCanvas } = await import('html-to-image')
  // Keep exact computed font sizes: the library otherwise rounds and shrinks font-size.
  const properties = [...getComputedStyle(document.documentElement)].filter((name) => name !== 'font-size')
  properties.push('font')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      toCanvas(frame, { width, height, pixelRatio, includeStyleProperties: properties, skipAutoScale: true }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Diagram capture timed out')), 20000) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function snapshotCanvas(snapshot: DiagramSnapshot, options: SnapshotOptions, pixelRatio = 2): Promise<HTMLCanvasElement> {
  if (snapshot.disposed) throw new Error('Diagram snapshot was disposed')
  const frame = prepareSnapshot(snapshot, options)
  snapshot.frame.parentElement!.append(frame)
  try {
    return await captureFrame(frame, snapshot.width, snapshot.height, pixelRatio)
  } finally {
    frame.remove()
  }
}

export async function snapshotPdf(snapshot: DiagramSnapshot, options: SnapshotOptions, title: string): Promise<SnapshotPdfResult> {
  if (options.extent === 'selection') return (await import('./selection')).selectionPdf(snapshot, options, title)
  const [{ PDFDocument }, canvas] = await Promise.all([import('pdf-lib'), snapshotCanvas(snapshot, options)])
  const doc = await PDFDocument.create()
  doc.setTitle(title)
  const png = canvas.toDataURL('image/png')
  const image = await doc.embedPng(png)
  const page = doc.addPage([snapshot.width * 0.75, snapshot.height * 0.75])
  page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() })
  return { bytes: await doc.save(), pages: [{ png, width: snapshot.width, height: snapshot.height }] }
}
