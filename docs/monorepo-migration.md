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

The initial migration checked both services on every PR. CI now selects service
jobs by application/build inputs. Documentation, workflow, root tooling and
deployment-only changes do not independently select backend/frontend checks.
The unconditional repository-policy job validates tooling and workflow syntax;
the final gate requires all selected checks and accepts deliberate skips.
See AGENTS.md for the current path rules.

Docker publication is a separate workflow_dispatch-only workflow. It reads
committed service versions, requires exactly one stable SemVer step from the
latest published Hub version, publishes version tags and promotes staging by
digest. It never edits source versions, moves prod/latest or deploys a server.

The source repositories remain intact. Their archival is performed by the owner.
GitHub issues/releases and private Actions settings are not copied; source links
remain available. No credentials are copied into this public repository.
