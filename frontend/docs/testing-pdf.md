# Current-view PDF export

The planning pages export the existing diagram DOM instead of drawing a second diagram from a separate palette and layout. The existing print dialog, filters, download/print buttons and Ctrl/Cmd+S/P entry points remain in use.

Opening the dialog freezes the viewport geometry, styles, data model and current scroll offsets. Display options modify an isolated copy. The live planner is never scrolled, restyled or filtered by export, and later planning refreshes do not change the frozen snapshot. No backend export endpoint is involved.

The output keeps the visible horizontal window and zoom, includes every row of the selected objects, and repeats the calendar/resource header on each page. Groups remain together when they fit on a page; longer groups break between rows. Page dimensions follow the captured viewport (`CSS px × 0.75 = PDF pt`). The image is rendered at double resolution. It preserves layout and appearance, but its text is not selectable. PDF viewers and physical printers can apply their own zoom or paper fitting.

## Verification

```sh
npm run check
npm run lint
npm run test:stories -- --project unit
PLAYWRIGHT_CHANNEL=chrome npm run test:stories -- --project storybook src/components/planner/PdfExport/Snapshot.stories.ts src/components/planner/PdfExport/PdfExport.stories.ts
npm run test:pdf
npm run build
```

The application must already be running on `http://127.0.0.1:5173`, with the local backend on port 8080. The live browser runner reads the local administrator password from `../local/dev.env`, signs in, and uses controlled in-memory planning fixtures in an isolated browser context. It never changes real server data. It writes comparison PNGs and sample PDFs into `/tmp/erp-pdf-snapshot`.

The screenshot comparison covers project, process and task diagrams in days and ISO weeks, light/dark schemes, zoom 75%/100%/150%, partial columns, vertical scrolling, badges, milestones, dependency arrows and resource headers. Pixel checks allow small rasterization differences at text/vector edges; they do not promise identical font antialiasing in every browser or operating system.

The browser workflow also verifies both keyboard shortcuts, a hidden export toolbar button, PDF page dimensions, downloads, printing dispatch, display toggles, process/project filters, the empty selection state, bar thickness and source isolation. Component tests cover a large structure, offscreen placeholders, sticky geometry, snapshot cleanup and changes to the page after opening print.

## Capture details

- Freeze sticky offsets before rasterization: a cloned scroll container does not retain scroll state.
- Preserve offscreen group heights while omitting their expensive descendants.
- Skip HTML comments, which may contain sequences invalid in XML foreignObject serialization.
- Copy the computed font shorthand and exclude the capture library's font-size rounding.
- Keep capture asynchronous work bounded and release temporary DOM nodes when closing the dialog.
- Keep legacy renderer regression stories while the current-view export is being validated; application downloads use the DOM snapshot path.
