#!/usr/bin/env bash
set -euo pipefail
: "${RBAC_TEST_API_URL:?Set a loopback backend URL ending in /api/v1}"
: "${RBAC_TEST_ADMIN_PASSWORD:?Set the local administrator password}"
go test -p 2 -count=1 -v ./internal/authz/engine -run '^TestHTTPPermissionActions$'
