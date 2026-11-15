# Deployment branding

Clockwork is the built-in product identity. A deployment can override its name,
logo and primary color without rebuilding images or changing the database.
The same settings apply to the web UI and Electron connected to that server.

On the existing server, create `/opt/erp/assets/custom/branding/config.json`:

```json
{
  "name": "Company planning",
  "primaryColor": "#7841AF",
  "logo": "logo.png"
}
```

Copy `logo.png` into the same directory. The existing Compose custom-assets
mount serves this directory; no additional mount or environment secret is needed.
The directory must be traversable and files readable by nginx (typically 0755
and 0644). Replace complete files atomically, then reload the application.
These assets are public: never place secrets in this directory.

Use `deploy/branding.example.json` for Clockwork's defaults, including the
`erp.koshsky.ru` stand. A missing configuration also selects those defaults.
Omitted or invalid fields fall back independently. To remove a custom logo,
set `logo` to `null`; to reset the deployment, remove the configuration file.
Changes become visible after application reload or reconnection. The static
pre-JavaScript splash and installed desktop product name remain Clockwork;
the connected application's title, login, navigation and favicon follow the
deployment identity.

Names accept up to 80 characters, rendered as plain text. Colors use `#RRGGBB`.
Light/dark themes derive readable accents and foreground colors, so very pale
or dark choices may be adjusted for contrast. The default color keeps the
existing theme exactly. Status colors, resource availability indicators and
user-selected Gantt bar colors keep their existing meaning. Print/PDF captures
the resulting page styles through the existing snapshot path.

Logos accept sibling static PNG, JPEG or WebP files up to 256 KiB, 2048 pixels
on either side and 1,048,576 pixels total. Dimensions are checked before decoding;
animated PNG/WebP, URL references, subdirectories and SVG are not accepted.
Raster bytes become an embedded image,
so CSP stays same-origin and PDF/offline views need no remote logo request.
An unavailable or invalid logo leaves the configured name visible.

Electron fetches public branding in its main process, with normal TLS checking,
no credentials, no redirects, bounded responses and a short timeout. It retains
the last valid identity in its profile, keyed by server origin, and restores it
offline. An HTTP 404 explicitly resets a cached identity. A network failure or
malformed response or transient logo failure preserves the complete last valid
identity for that server. A removed or invalid logo may clear the cached logo.
The cache keeps at most eight server origins (up to 4 MiB total) and evicts the
oldest entries without touching sessions, SQLite or queued commands. Existing
application IDs, profile paths, JWT issuer and queued data are unchanged.

Both processes emit `[branding]` diagnostics to their developer console for
invalid configuration, unavailable logos and cache failures, limited to one
warning per minute per process. Codes contain no server URLs, file paths,
configuration values or raw exception messages. Missing configuration (HTTP 404)
is the supported default and does not produce a warning. A browser reconnect
preserves the currently loaded brand until a successful refresh; switching
servers clears it immediately. Language changes do not replace the product title.

For local development place the same directory under
`frontend/public/assets/custom/branding/` (ignored by Git). No backend restart is
needed. Server changes still follow the repository's reviewed deployment process;
changing source defaults does not update an already published image.
