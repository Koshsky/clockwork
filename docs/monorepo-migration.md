# Monorepo migration

The user selected a fresh initial commit rather than importing Git history or
GitHub releases. Historical references stay in the source repositories:

- https://github.com/Koshsky/erp-frontend — source main d9892d2.
- https://github.com/Koshsky/erp-backend — source main 039037b.

Local mirror/bundle backups and the experimental history import were retained
outside this repository. No old tags are published in Clockwork. Service source
versions remain frontend 1.6.3 and backend 1.4.3; Docker images and deployment tags
are unchanged. No server deployment is part of this migration.

The backend is an application, not a newly published Go library. Its existing
`github.com/Koshsky/erp-backend` module identity and internal imports are retained
for this source relocation. Build it from backend/; do not advertise a new
`go install github.com/Koshsky/clockwork/backend/...` path. Module-path migration
can be a separate mechanical change if public Go-module distribution is needed.

Electron appId, product name and userData remain unchanged. A repository rename
must not create an empty profile or orphan offline work. Separation of the offline
engine is the next project after repository acceptance.

Every PR checks both services. This intentionally favors complete coverage over
path filtering for the initial migration; there are no skipped required jobs.
CI does not publish Docker images, move deployment tags or deploy a server.

The source repositories remain intact. Their archival is performed by the owner.
GitHub issues/releases and private Actions settings are not copied; source links
remain available. No credentials are copied into this public repository.
