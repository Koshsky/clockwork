import { PDFDocument } from 'pdf-lib'
import { captureFrame, prepareSnapshot } from './snapshot'
import type { DiagramSnapshot, SnapshotOptions, SnapshotPdfResult, SnapshotPrintPage } from './snapshot'

/** Keep rows intact; every page has the same horizontal window and repeated header. */
export function pageSlices(height: number, capacity: number, boundaries: number[], groups: { from: number; to: number }[] = []): { from: number; to: number }[] {
  if (capacity <= 0) throw new Error('No space below the print header')
  const points = [...new Set([0, ...boundaries, ...groups.flatMap((group) => [group.from, group.to]), height])].sort((a, b) => a - b)
  const pages: { from: number; to: number }[] = []
  for (let from = 0; from < height;) {
    const limit = Math.min(height, from + capacity)
    const candidates = points.filter((point) => point > from + 0.5 && point <= limit + 0.01)
    let to = candidates[candidates.length - 1] ?? limit
    const split = groups.find((group) => group.from > from + 0.5 && group.from < to && group.to > to + 0.01 && group.to - group.from <= capacity)
    if (split) to = split.from
    pages.push({ from, to })
    from = to
    if (pages.length > 200) throw new Error('Too many print pages')
  }
  return pages.length ? pages : [{ from: 0, to: 0 }]
}

function prunePage(frame: HTMLElement, header: number, height: number, scale: number) {
  const root = frame.getBoundingClientRect()
  for (const label of frame.querySelectorAll<HTMLElement>('.gg-merged')) {
    const group = label.parentElement!.getBoundingClientRect()
    const top = Math.max(root.top + header, group.top), bottom = Math.min(root.top + height, group.bottom)
    if (bottom <= top || (group.top >= root.top + header && group.bottom <= root.top + height)) continue
    Object.assign(label.style, { position: 'absolute', left: '0', top: `${(top - group.top) / scale}px`,
      height: `${(bottom - top) / scale}px`, marginBottom: '0' })
  }
  for (const node of frame.querySelectorAll<HTMLElement>('.tg-task-group, .gg-group, .gg-row')) {
    if (!node.isConnected) continue
    const rect = node.getBoundingClientRect()
    if (rect.bottom > root.top + header && rect.top < root.top + height) continue
    const spacer = document.createElement('div')
    spacer.style.height = `${rect.height / scale}px`
    node.replaceWith(spacer)
  }
}

export async function selectionPdf(snapshot: DiagramSnapshot, options: SnapshotOptions, title: string): Promise<SnapshotPdfResult> {
  if (snapshot.disposed) throw new Error('Diagram snapshot was disposed')
  const frame = prepareSnapshot(snapshot, options)
  snapshot.frame.parentElement!.append(frame)
  try {
    const content = frame.querySelector<HTMLElement>('.tg-content')!
    const groups = [...content.children].filter((element) => element.matches('.tg-task-group, .gg-group'))
    const clip = document.createElement('div'), body = document.createElement('div')
    Object.assign(clip.style, { position: 'relative', overflow: 'hidden' })
    body.style.position = 'relative'
    clip.append(body)
    content.append(clip)
    for (const group of groups) body.append(group)
    const root = frame.getBoundingClientRect(), start = body.getBoundingClientRect()
    const header = start.top - root.top
    const height = start.height
    const pageHeight = Math.max(snapshot.height, header + 100 * snapshot.scale)
    const boundaries = [...body.querySelectorAll('.gg-row, .tg-task-group')].map((row) => row.getBoundingClientRect().top - start.top)
    const groupRanges = [...body.children].map((group) => { const rect = group.getBoundingClientRect(); return { from: rect.top - start.top, to: rect.bottom - start.top } })
    const slices = pageSlices(height, pageHeight - header, boundaries, groupRanges)
    const doc = await PDFDocument.create()
    doc.setTitle(title)
    const pages: SnapshotPrintPage[] = []
    const backdrop = content.querySelector<HTMLElement>('.tg-side-col')
    if (backdrop) {
      backdrop.style.height = `${pageHeight / snapshot.scale}px`
      backdrop.style.marginBottom = `${-pageHeight / snapshot.scale}px`
    }
    content.style.setProperty('--tg-fit-height', `${pageHeight / snapshot.scale}px`)
    frame.style.height = `${pageHeight}px`
    for (const slice of slices) {
      if (options.cancelled?.()) throw new Error('Print settings changed')
      if (snapshot.disposed) throw new Error('Diagram snapshot was disposed')
      clip.style.height = `${(slice.to - slice.from) / snapshot.scale}px`
      body.style.top = `${-slice.from / snapshot.scale}px`
      const pageFrame = frame.cloneNode(true) as HTMLElement
      snapshot.frame.parentElement!.append(pageFrame)
      try {
        prunePage(pageFrame, header, header + slice.to - slice.from, snapshot.scale)
        const canvas = await captureFrame(pageFrame, snapshot.width, pageHeight)
        const png = canvas.toDataURL('image/png')
        pages.push({ png, width: snapshot.width, height: pageHeight })
        const image = await doc.embedPng(png)
        canvas.width = 0
        canvas.height = 0
        const page = doc.addPage([snapshot.width * 0.75, pageHeight * 0.75])
        page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() })
      } finally {
        pageFrame.remove()
      }
    }
    return { bytes: await doc.save(), pages }
  } finally {
    frame.remove()
  }
}
