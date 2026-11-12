# AGENTS.md

Frontend service of the MVS ERP monorepo (repo root is `..`, sibling `backend` is the Go API serving `/api/v1`). Stack: Vue 3 (`<script setup>`) + TypeScript + Vite + Pinia + Vue Router, component-driven with Storybook.

## Language rule (mandatory)

- Code comments, documentation, and commit messages are written in **English only**.
- The UI is **bilingual (Russian + English)**. Russian is the source of truth
  and the fallback, English is the translation. User-facing strings never live
  inline in components: they live in the catalogs `src/i18n/locales/ru/*` and
  `src/i18n/locales/en/*` (split by domain) and are read with `t()` from
  `src/i18n` — the active locale follows the `uiLanguage` setting.
- Adding or changing a visible string means updating **both** catalogs in the
  same commit; `src/i18n/locales.test.ts` enforces key parity (mirrored by
  `AGENTS.md` rule checks). The gate `src/i18n/hardcodedText.test.ts` fails on
  Russian text left inline in a component, a template node or an attribute
  value; the documented escapes are the catalogs, the `i18n-allow` line marker
  (own-language names, dev-console logs, internal Error texts, each with a
  reason) and the functional data allowlist in the test.
- Text that must re-render on a language switch is computed inside a function /
  `computed` — module-level `t()` snapshots and materialized view models freeze
  the language (use `appLocale` from `src/i18n` for a reactive dependency).
- Dates and numbers go through `src/i18n/date.ts` (Intl per locale), never
  through a hardcoded `'ru'`/`'ru-RU'` locale.
- Server-stored data (user, project, process, task, comment, preset and state
  names) is not translated.
- **Deliberate exception — changelogs are split per language**: `Changelog_ENG.md` (English) and `Changelog_RU.md` (Russian), see the Changelog section below.

## Commands
- `npm run dev` runs **Storybook** (port 6006) — not the app. `npm start` runs the Vite dev server (port 5173); `npm run stop` kills it.
- The Vite dev server caches SFC transforms and, after edits, can serve a **torn module** (fresh `<script setup>` + an old render function). Symptom: a setting changes in the store but the UI does not react, while the file on disk, the type check and the story tests are all fine. Fix: restart the server (`npm run stop && npm start`); a quick alternative is `touch` on the edited file plus a page reload. To see what the server actually returns, check the render condition, e.g. `curl -s 'http://127.0.0.1:5173/src/<path>.vue' | grep -n 'tb-comments' -B3` — it must reference the current bindings.
- There is **no `npm test`**. Vitest tests run through Storybook's `@storybook/addon-vitest` (`.stories.ts` files).
- Stories take their assertions from `storybook/test` (`import { expect } from 'storybook/test'`), **never from `vitest`**: a story also renders in the `storybook dev` canvas, where vitest's `expect` throws at import time and the story fails with "The component failed to render properly". ESLint enforces this (`no-restricted-imports`/`no-restricted-syntax` for `src/**/*.stories.ts`).
- `npm run check` (alias `typecheck`) = `vue-tsc --noEmit` — the type gate, run after edits.
- `npm run lint` = `eslint src --max-warnings 0` — the lint gate (flat config in `eslint.config.js`; generated `src/api` is excluded), run after edits; **0 problems required**.
- `npm run build` = `vite build` → `dist/`.

## Changelog
- When a user-facing change lands, add a **brief, laconic, one-line bullet** (no long descriptions, no examples) under `## [Unreleased]` in BOTH `Changelog_ENG.md` (English) and `Changelog_RU.md` (Russian) in the same commit (see root `AGENTS.md` → Changelog (between releases)).
- **Notable changes only**: cosmetic polish (spacing, sizes, row or card layout, tab order, hint and label texts) gets no bullet — fold it into the bullet of the feature it belongs to, or skip it. The criteria and examples live in the root `AGENTS.md`.

## Desktop releases — always via `desktop/build-portable.sh`
- Produce desktop artifacts **only** through `desktop/build-portable.sh` from
  `desktop/`. It always rebuilds `dist/` from sources (deletes `dist/`, purges
  the vite caches) and verifies the result, because the Electron wrapper embeds
  `dist/` into the release as `resources/web` (`extraResources` in
  `desktop/package.json`).
- Versioning: web and desktop share ONE version — the single source of truth
  is this service's `package.json`; `build-portable.sh` always builds that
  version as is (it never bumps or accepts a version override). Desktop source
  package metadata has no version; `desktop/build.cjs` injects the canonical
  version into the packaged app without rewriting tracked manifests. Vite reads
  the same source; `APP_VERSION`, when supplied, must match it. Use
  `npm version patch --no-git-tag-version` (or minor/major) to update the source
  and npm lockfile.
- **Never** run `electron-builder` / `npm run dist*` by hand against a
  pre-existing `dist/`: a stale `dist/` gets embedded into a newly versioned
  release, so the app shows old UI (removed pages still visible) while its
  version says otherwise. `--build-web` is a deprecated no-op — the web build is
  unconditional.
- Diagnosing "the packaged app shows old UI": read
  `desktop/release/<version>/<app>-unpacked/resources/web/precache-manifest.json`
  — `version` must equal the release version. A git-hash value
  (e.g. `1808c37-mtx0hk8x`) means a stale bundle was embedded.

## Desktop storage

Electron's durable store lives in `desktop/storage*.cjs`, outside the renderer.
Use the pinned Electron runtime's built-in `node:sqlite` only in its Node worker;
do not add a native npm driver or expose SQL/filesystem access through preload.
Namespaces use the normalized remote server and account ID, never the loopback
port. Projection changes, queued intents and receipts share a transaction; a
renderer acknowledgement must follow durable commit. Never reset an incompatible
or damaged database automatically. Back up before schema upgrades and restore
only into an empty profile. Keep credentials in the OS-protected session vault.
The owner treats the future SQLite desktop as its first release: no legacy
IndexedDB importer is required. Web must not read, replay, prune or clear legacy
IndexedDB; its GET cache is in memory and its session uses the HttpOnly cookie.
Queue/cache diagnostics and server selection are desktop-only, including direct
URLs. Business adapters are later separation stages;
future SQLite updates must preserve snapshots and unsynchronized commands.

Run `node --test tests/desktop-storage.test.cjs` and
`node scripts/test-desktop-storage.cjs` from `frontend/`; the latter uses native
Electron and a temporary ASAR fixture. CI runs it on Windows, Linux and macOS.
For GUI integration, set `ELECTRON_EXECUTABLE` and run
`node tests/desktop-storage.mjs` with an isolated temporary profile.

## `src/api/` is generated — do not hand-edit
- Generated by OpenAPI Generator v7.24.0 (see `openapitools.json`) from `../backend/docs/swagger/swagger.yaml`. After the backend contract changes, regenerate the client; manual edits to `src/api/*.ts` are lost on regeneration (respect `.openapi-generator-ignore`).

## Environment
- Copy `.env.example` → `.env`. `VITE_API_URL` (default `/api/v1`) is the API base passed to the client via `Configuration` in `src/store/index.ts`.
- **The web build MUST be same-origin** (nginx proxy or the vite `/api` dev proxy): the HttpOnly refresh cookie (`mvs_refresh`, Path=`/api/v1/auth`) does not survive a cross-origin API base — `/auth/refresh` would always 401 and the user would be logged out on every access-token expiry. Do not point `VITE_API_URL` at an absolute cross-origin URL in the web build.
- `VITE_API_PROXY_TARGET` (default `http://localhost:8080`) is the dev proxy target for `/api` (vite.config.ts).
- Docker build bakes `VITE_API_BASE` in as a build-arg (Dockerfile); `.env` is gitignored.

## Architecture rules (repo conventions, keep them)
- API calls are allowed **only** in `views/`, `composables/`, and `store/`. Components under `src/components/` must never import `@/api` or fetch; they receive data via props/emit or read Pinia. Views load via stores and pass down props (see `views/PlannerPage.vue`).
- Backend always returns `{ data, error }`; unwrap the payload via `data` and never read other top-level fields. `data` is an object/list container, not a bare array.
- Auth: web access tokens stay in memory and refresh uses the same-origin HttpOnly cookie. Electron owns all tokens and API authorization in main, with OS-protected persistence; renderer session state contains no tokens. Public identity metadata may be cached in localStorage. The router guard redirects unauthenticated users to `/login` (add `meta: { requiresAuth: true }` on protected routes).

## Component conventions
- Each component dir ships `X.vue` + `types.ts` + `argTypes.ts` + `X.stories.ts` + `index.ts` (barrel re-export, aggregated in `src/components/planner/index.ts`).
- **Stacking order is a token, never a number**: `z-index` comes from the `--z-*` ladder in `styles/tokens.css` (documented there in the order content → resource cells → header → today line → scale badge → side panel → corner). A raw numeric `z-index` in a component fails the gate `src/styles/zIndex.test.ts`, which also checks that every used token is declared and that the ladder stays strictly increasing.
- Storybook exposes global `theme` (default/compact/minimal) and `scheme` (light/dark) toolbars via decorators in `.storybook/decorators/`; new components/stories must work in all combos.
- Gantt positioning uses cell offsets from an `anchor` reference for a `mode` (`quarter`/`half`/`year` = number of calendar months from the anchor's month) and a `unit` (`day`/`decade`). Decade cells are aligned to calendar months (1–10, 11–20, 21–end); the first decade of the anchor month is partial (starts at the anchor). Keep date math in `src/components/planner/calendar.ts`, not the store.

## Running the full stack
- `docker-compose.yml` here runs the frontend alone (port 3000). The full stack (Caddy → frontend + Go backend + PostgreSQL, with native embedded migrations) is in `../compose.yaml`.

## Branch workflow

`main` is the only permanent branch. Create short-lived topic branches from the
current `origin/main`, submit pull requests into `main`, and remove topic branches
after merging. Do not recreate `dev` or `staging` Git branches. Preserve published
release tags; Docker deployment tags are independent of Git branch names.
