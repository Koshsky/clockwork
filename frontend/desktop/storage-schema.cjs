'use strict'

const { createHash } = require('node:crypto')
const applicationId = 0x434c4b57
const migrations = [
  { version: 1, name: 'scoped_storage', sql: `
CREATE TABLE storage_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT;
CREATE TABLE scopes (id INTEGER PRIMARY KEY, server TEXT NOT NULL, account_id INTEGER NOT NULL, UNIQUE(server, account_id)) STRICT;
CREATE TABLE snapshots (scope_id INTEGER NOT NULL REFERENCES scopes(id), domain TEXT NOT NULL, key TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(scope_id, domain, key)) STRICT;
CREATE TABLE commands (sequence INTEGER PRIMARY KEY AUTOINCREMENT, scope_id INTEGER NOT NULL REFERENCES scopes(id), operation_id TEXT NOT NULL, operation TEXT NOT NULL, input TEXT NOT NULL, idempotency_key TEXT NOT NULL, digest TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(scope_id, operation_id), UNIQUE(scope_id, idempotency_key)) STRICT;
CREATE TABLE dependencies (scope_id INTEGER NOT NULL, operation_id TEXT NOT NULL, depends_on TEXT NOT NULL, PRIMARY KEY(scope_id, operation_id, depends_on), FOREIGN KEY(scope_id, operation_id) REFERENCES commands(scope_id, operation_id), FOREIGN KEY(scope_id, depends_on) REFERENCES commands(scope_id, operation_id)) STRICT;
CREATE TABLE command_snapshots (scope_id INTEGER NOT NULL, operation_id TEXT NOT NULL, domain TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY(scope_id, operation_id, domain, key), FOREIGN KEY(scope_id, operation_id) REFERENCES commands(scope_id, operation_id)) STRICT;
CREATE TABLE idmap (scope_id INTEGER NOT NULL REFERENCES scopes(id), entity TEXT NOT NULL, temporary_id INTEGER NOT NULL, real_id INTEGER NOT NULL, operation_id TEXT NOT NULL, PRIMARY KEY(scope_id, entity, temporary_id), FOREIGN KEY(scope_id, operation_id) REFERENCES commands(scope_id, operation_id)) STRICT;
CREATE TABLE receipts (scope_id INTEGER NOT NULL, operation_id TEXT NOT NULL, status TEXT NOT NULL, result TEXT, settlement_digest TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY(scope_id, operation_id), FOREIGN KEY(scope_id, operation_id) REFERENCES commands(scope_id, operation_id)) STRICT;
CREATE TABLE settings (scope_id INTEGER NOT NULL REFERENCES scopes(id), key TEXT NOT NULL, value TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(scope_id, key)) STRICT;
` },
  { version: 2, name: 'queue_indexes', sql: `
CREATE INDEX commands_pending ON commands(scope_id, status, sequence);
CREATE INDEX dependencies_reverse ON dependencies(scope_id, depends_on);
CREATE INDEX command_snapshots_lookup ON command_snapshots(scope_id, domain, key);
` },
].map(migration => ({ ...migration, checksum: createHash('sha256').update(migration.sql).digest('hex') }))
module.exports = { applicationId, migrations, schemaVersion: migrations.at(-1).version }
