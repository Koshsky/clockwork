import type { SnapshotPrintPage } from './snapshot'

/** Print the exact captured images without depending on the browser's PDF-viewer plugin. */
export async function printSnapshotPages(pages: SnapshotPrintPage[]): Promise<void> {
  if (!pages.length) throw new Error('No captured pages to print')
  const iframe = document.createElement('iframe')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'
  document.body.append(iframe)
  const target = iframe.contentWindow!, printDocument = iframe.contentDocument!
  const cleanup = () => { iframe.remove(); window.removeEventListener('afterprint', cleanup) }
  try {
    const style = printDocument.createElement('style')
    style.textContent = `@page { size: ${pages[0].width * 0.75}pt ${pages[0].height * 0.75}pt; margin: 0; }
      html, body { margin: 0; padding: 0; }
      img { display: block; break-after: page; page-break-after: always; }
      img:last-child { break-after: auto; page-break-after: auto; }`
    printDocument.head.append(style)
    const images = pages.map((page) => {
      const image = printDocument.createElement('img')
      image.src = page.png
      image.style.width = `${page.width}px`
      image.style.height = `${page.height}px`
      printDocument.body.append(image)
      return image.decode()
    })
    await Promise.all(images)
    target.addEventListener('afterprint', cleanup, { once: true })
    window.addEventListener('afterprint', cleanup, { once: true })
    target.print()
  } catch (error) {
    cleanup()
    throw error
  }
}
