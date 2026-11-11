#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
mkdir -p "$repo_dir/build"
work_dir=$(mktemp -d "$repo_dir/build/migration-test.XXXXXX")
suffix=${work_dir##*/}
network_name="erp-$suffix"
postgres_name="erp-pg-$suffix"
cleanup() {
  docker rm -fv "$postgres_name" >/dev/null 2>&1 || true
  docker network rm "$network_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

mkdir -p "$work_dir/sql/plugins" "$work_dir/sql/seed"
for version in 1 2 3 4 5 6 7 8 9; do
  cp "$repo_dir/migrations/V${version}__"*.sql "$work_dir/sql/"
done
# These scripts deliberately never enter the backend's embedded filesystem.
cat > "$work_dir/sql/plugins/V1007__site_extension.sql" <<'SQL'
CREATE TABLE site_extension (id bigint PRIMARY KEY, marker text NOT NULL);
INSERT INTO site_extension VALUES (1, 'installed by Flyway');
SQL
cat > "$work_dir/sql/plugins/V1008_1__site_extension_note.sql" <<'SQL'
ALTER TABLE site_extension ADD COLUMN note text;
UPDATE site_extension SET note = 'preserve across backend upgrade' WHERE id = 1;
SQL
cat > "$work_dir/sql/seed/V1020__fixture_users.sql" <<'SQL'
INSERT INTO users (id, username, last_name, first_name, password_hash, preset)
VALUES (4242, 'migration_fixture', 'Example', 'Migration', 'test-only-unused-hash', 'worker');
INSERT INTO projects (id, owner_id, code, start_date, end_date, priority)
VALUES (7301, 4242, 'MIGRATION-FIXTURE', CURRENT_DATE, CURRENT_DATE + 10, 0);
INSERT INTO processes (id, project_id, owner_id, title, start_date, end_date)
VALUES (7401, 7301, 4242, 'Migration process', CURRENT_DATE, CURRENT_DATE + 10);
INSERT INTO tasks (id, process_id, owner_id, title, start_date, end_date)
VALUES (7501, 7401, 4242, 'Migration task', CURRENT_DATE, CURRENT_DATE + 10);
SELECT setval(pg_get_serial_sequence('users', 'id'), (SELECT MAX(id) FROM users));
SELECT setval(pg_get_serial_sequence('projects', 'id'), (SELECT MAX(id) FROM projects));
SELECT setval(pg_get_serial_sequence('processes', 'id'), (SELECT MAX(id) FROM processes));
SELECT setval(pg_get_serial_sequence('tasks', 'id'), (SELECT MAX(id) FROM tasks));
SQL

docker network create "$network_name" >/dev/null
docker run -d --name "$postgres_name" --network "$network_name" --network-alias db \
  -p 127.0.0.1::5432 -e POSTGRES_USER=erp -e POSTGRES_PASSWORD=migration-test-only \
  -e POSTGRES_DB=erp_migrator_upgrade postgres:16-alpine >/dev/null
ready=false
for _ in {1..60}; do
  if docker exec "$postgres_name" pg_isready -U erp -d erp_migrator_upgrade >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [ "$ready" != true ]; then
  docker logs "$postgres_name"
  exit 1
fi
flyway() {
  docker run --rm --platform linux/amd64 --network "$network_name" \
    -v "$work_dir/sql:/flyway/sql:ro" -e JAVA_TOOL_OPTIONS=-Xint \
    -e FLYWAY_URL=jdbc:postgresql://db:5432/erp_migrator_upgrade \
    -e FLYWAY_USER=erp -e FLYWAY_PASSWORD=migration-test-only \
    -e FLYWAY_OUT_OF_ORDER=true '-e' 'FLYWAY_IGNORE_MIGRATION_PATTERNS=*:missing' \
    flyway/flyway:9.20.0 "$@"
}
address=$(docker port "$postgres_name" 5432/tcp)
port=${address##*:}
cd "$repo_dir"
flyway migrate > "$work_dir/flyway-v9.log" 2>&1
MIGRATION_TEST_DATABASE_URL="postgres://erp:migration-test-only@127.0.0.1:$port/erp_migrator_upgrade?sslmode=disable" \
  go test -p 2 -race -count=1 -v ./internal/migration | tee "$work_dir/go-test-v9.log"
# Recreate only this script's disposable database and let Flyway apply V10 itself.
docker exec "$postgres_name" dropdb -U erp erp_migrator_upgrade
docker exec "$postgres_name" createdb -U erp erp_migrator_upgrade
cp "$repo_dir/migrations/V10__entity_responsible.sql" "$work_dir/sql/"
flyway migrate > "$work_dir/flyway-v10.log" 2>&1
# A changed responsible field proves adoption does not replay V10's backfill.
docker exec "$postgres_name" psql -U erp -d erp_migrator_upgrade -c 'UPDATE tasks SET responsible_id=NULL WHERE id=7501' >/dev/null
MIGRATION_TEST_DATABASE_URL="postgres://erp:migration-test-only@127.0.0.1:$port/erp_migrator_upgrade?sslmode=disable" \
  go test -p 2 -race -count=1 -v ./internal/migration | tee "$work_dir/go-test-v10.log"
printf 'Both Flyway adoption scenarios passed. Logs: %s\n' "$work_dir"
