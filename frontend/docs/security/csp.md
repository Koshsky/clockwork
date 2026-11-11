# Content Security Policy

The policy source is `desktop/security.cjs`. Web nginx headers are checked in as
`security-headers.conf`; run `npm run security:csp:sync` after editing the source.
The consistency test fails if these files diverge.

The frontend Dockerfile copies the snippet into nginx. Every location declaring
`add_header` includes it explicitly: nginx 1.28 replaces inherited headers in
these locations. This also preserves CSP on worker scripts, custom assets and
404 responses. An upstream reverse proxy must not replace this policy with a
weaker or incompatible one.

Desktop adds the same security headers through its local HTTP server, including
SPA fallbacks and error responses. The policy and server modules are explicitly
included in the desktop packaging manifest.

## Allowed capabilities

| Capability | Web | Desktop | Reason |
| --- | --- | --- | --- |
| Scripts and workers | Same origin | Same origin | Bundled application code and the local PDF worker fallback |
| Inline scripts, event attributes and eval | Blocked | Blocked | No application feature requires injected JavaScript |
| Styles | Same origin and inline | Same origin and inline | Gantt positioning, themes, DOM snapshots and print-page sizing |
| Images | Same origin, data URLs, service.mvsservice.ru | Same | PNG/SVG snapshots and the existing favicon |
| Fonts | Same origin and data URLs | Same | Bundled fonts and DOM-to-image font embedding |
| Connections | Same origin | Same origin and HTTP(S) | Web uses its API proxy; desktop allows the user to select a backend at runtime |
| Child frames | Same origin | Same origin | Printing uses an initial about:blank iframe inheriting the parent policy |
| Embedding the application | Blocked | Blocked | frame-ancestors none and X-Frame-Options DENY |
| Objects and base URL changes | Blocked | Blocked | No corresponding application feature |

Desktop's HTTP(S) connection exception does **not** allow remote scripts,
frames or executable blob/data URLs. It preserves the existing editable backend
address. Restricting connections to one selected origin would require a separate
server-selection and document-reload design; this change does not pretend to
provide that restriction.

PDF.js receives `isEvalSupported: false`. The policy never needs `unsafe-eval`,
`unsafe-inline` for scripts, broad executable schemes, or `webSecurity: false`.

## Offline behavior

The current application uses IndexedDB for cached API responses, sessions and
its mutation queue. It does not register a Service Worker. CSP preserves this
behavior; it does not add offline installation or cache the browser app shell.

The six P0 tests cover API outages, reload with queued changes, recovery, lost
responses after a backend commit, dependent temporary IDs, rejected mutations
and reload during queue flushing. Web assets remain available from the test
server while the API is disconnected, as does the desktop loopback server when
the remote API is unavailable. A browser reload with *both* its web server and
all app-shell assets unavailable is outside the existing offline contract.

## Verification without a build

- `npm run check`
- `npm run lint`
- `npm run test:stories -- --project unit`
- `npm run test:csp`
- `npm run test:csp:nginx`

The browser tests serve current Vue/TypeScript sources through an isolated Vite
server with **enforced** CSP and HMR disabled. They do not consume or rebuild
`dist`. They check actual PDF preview/download, Ctrl+S/Ctrl+P, printing and image
decoding in the print iframe, days and weeks, local workers, code-injection
probes and all six P0 recovery scenarios against a loopback backend.

Set `ERP_TEST_ENV` or `ERP_TEST_PASSWORD` for local administrator credentials.
`ERP_TEST_API` defaults to `http://127.0.0.1:8080`; only loopback backends are
accepted. The tests create and remove their own backend fixtures.

To run desktop scenarios in native Electron instead of Chromium, set
`ELECTRON_EXECUTABLE` to an installed runtime matching `desktop/package.json`.
The test shell uses the actual desktop preload with context isolation and
sandboxing enabled, and Node integration disabled, in a disposable user-data directory.
No installer or application bundle is built. A missing native runtime means
Chromium checks the desktop policy while Node tests the actual desktop HTTP
handler; it does not count as a native Electron run.

The nginx test starts a disposable container from an existing image, mounts the
current config and tiny static fixtures, checks HTML, SPA routes, assets, workers,
cache headers and errors, and then removes it. `CSP_NGINX_IMAGE` selects the
installed image; no Docker build or production container is involved.

## References

- [MDN: Content Security Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CSP)
- [Electron: security recommendations](https://www.electronjs.org/docs/latest/tutorial/security)
