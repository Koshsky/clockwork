# Stored XSS defenses and regression tests

API text remains plain data in storage. Vue interpolation renders comments,
project codes, process/task names, resource titles and person names as text.
Do not replace those bindings with raw HTML rendering.

The two intentionally rich-content boundaries have additional protections:

- Markdown links are checked using the browser's URL parser against an inert
  HTTPS base. C0 controls and DEL are rejected before parsing; this prevents
  embedded tabs/newlines from disguising a JavaScript scheme. Only HTTP, HTTPS
  and mailto links are allowed. Raw HTML remains escaped and links retain
  `noopener noreferrer`.
- Runtime SVG icons pass through DOMPurify and an allowlist of static SVG
  geometry and attributes. The resolver returns the sanitized DOM serialization,
  never the original input. Invalid overrides fall back to bundled icons, even
  when a caller supplies a permissive extra validator.

Navigation icons support svg/g, paths, circles, ellipses, rectangles, lines,
polylines, polygons, titles and descriptions, with static colors and geometric
attributes. HTML namespaces, foreignObject, embedded frames/images, links, CSS,
URL paints (including CSS escapes), animation and nested SVG roots are rejected.
All bundled Lucide icons are covered by preservation tests. More complex custom
icons using gradients, references or CSS must be converted to this static subset;
they fall back to defaults rather than widening the execution boundary.

CSP is an additional layer. The XSS suite also runs without CSP and checks that
no attacker elements or executable links reach the DOM, no probe executes and
no beacon is requested. With CSP enabled it additionally expects zero violations:
CSP must not conceal an escaping/sanitization failure.

## Run without building

- `npm run check`
- `npm run lint`
- `npm run test:stories -- --project unit`
- `npm run test:xss`

`test:xss` serves current sources through isolated Vite servers, first without
CSP and then with the enforced web policy. HMR and console forwarding are disabled.
No application bundle, installer or Docker image is built.

The local backend defaults to `http://127.0.0.1:8080`; external backends are
rejected. Set `ERP_TEST_PASSWORD` or `ERP_TEST_ENV` for local administrator
fixture setup. `XSS_CSP=off` or `XSS_CSP=on` selects one test mode.

The suite creates two independent accounts. The author saves hostile project,
process, task and resource strings and task comments through the real API using
its own token. A distinct reader opens the actual resource table (including
owner names), all three Gantt pages and task discussions. The strings are checked
against persisted API responses, without seeding client stores with fake data.

API access is then disconnected and the document reloaded. Planning, permissions,
resource and comment data must render from the reader's IndexedDB cache. Both
calendar units export valid PDFs; PDF dictionaries are checked for executable
JavaScript and automatic actions. The browser's app-shell assets remain available
from the local test server, matching the existing offline API contract.

Hints and custom SVGs are deployment files, not ordinary-user API fields. Tests
keep that distinction: the real navigation asset resolver receives the hostile
SVG fixture, and the actual Markdown component is exercised separately with the
hostile strings received through the reader's API. Benign Markdown formatting,
HTTPS links and bundled navigation icons must remain usable.

Backend fixtures are deleted in dependency order: assignments/tasks/processes/
projects, then resources, then users. Output PDFs are stored under
`/tmp/erp-xss-tests`; no production data or installed user profile is touched.
