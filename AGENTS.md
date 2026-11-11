# Clockwork contributor instructions

Read the relevant service's AGENTS.md before editing it. Code comments,
documentation and commit messages use English; product UI is bilingual RU/EN.

`main` is the only permanent branch. Work in short-lived topic branches and merge
into main after checks. Do not recreate dev/staging Git branches. Deployment tags
in Docker Hub are independent from Git branches.

Keep the Go and npm projects separate: run Go commands in backend/ and npm commands
in frontend/. Do not edit generated Go or TypeScript manually. Existing migration
files and published versions are immutable. Record new release versions in both
service changelogs before building and publishing images.

The migration keeps service versions, Docker names, the Go module path, Electron
appId/userData and existing runtime behavior stable. Offline separation is a
subsequent project, not part of this repository move.

Never commit env files, database dumps, plugins, personal seed data, local tracker
credentials or installed dependencies. A single root .gitignore governs both
services. Service .dockerignore files remain necessary for their build contexts.

Run make check or the focused service checks appropriate to the change. This is
not an Arcadia checkout; ya commands and monorepo-wide formatting do not apply.
Deployment, archival of source repositories and image-tag promotion require the
user's instruction; a normal push does not deploy anything.
