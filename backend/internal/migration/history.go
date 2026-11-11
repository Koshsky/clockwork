package migration

import (
	"context"
	"fmt"
	"path"
	"strconv"
	"strings"
	"unicode/utf16"

	"github.com/jackc/pgx/v5"

	apperrors "github.com/Koshsky/erp-backend/internal/errors"
)

const historyName = "flyway_schema_history"

// Flyway 9 uses this magic number plus Java's hashCode of the quoted table name.
func flywayLockID(qualified string) int64 {
	const magic = 0x466c79776179
	const javaHashMultiplier = 31
	var hash int32
	for _, char := range utf16.Encode([]rune(qualified)) {
		hash = javaHashMultiplier*hash + int32(char)
	}
	return magic + int64(hash)
}

func prepareHistory(ctx context.Context, tx pgx.Tx) (string, error) {
	var schema string
	if err := tx.QueryRow(ctx, "SELECT current_schema()").Scan(&schema); err != nil {
		return "", fmt.Errorf("read migration schema: %w", err)
	}
	table := pgx.Identifier{schema, historyName}.Sanitize()
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", flywayLockID(table)); err != nil {
		return "", fmt.Errorf("lock migrations: %w", err)
	}
	return table, nil
}

func appliedVersions(ctx context.Context, tx pgx.Tx, table string, scripts []script) (map[string]bool, error) {
	known := make(map[string]script, len(scripts))
	for _, item := range scripts {
		known[strconv.FormatInt(item.version, 10)] = item
	}
	rows, err := tx.Query(ctx, "SELECT version, type, script, checksum, success FROM "+table+" ORDER BY installed_rank")
	if err != nil {
		return nil, fmt.Errorf("read migration history: %w", err)
	}
	defer rows.Close()
	applied := make(map[string]bool)
	for rows.Next() {
		var checksum *int64
		var text *string
		var kind, filename string
		var success bool
		if err = rows.Scan(&text, &kind, &filename, &checksum, &success); err != nil {
			return nil, fmt.Errorf("scan migration history: %w", err)
		}
		if kind != "SQL" || !success {
			return nil, fmt.Errorf(
				"%w: unsupported or failed history entry %s",
				apperrors.ErrMigrationValidation,
				filename,
			)
		}
		// A historical repeatable script is external to the versioned core too.
		if text == nil {
			continue
		}
		version, parseErr := historyVersion(*text)
		if parseErr != nil {
			return nil, parseErr
		}
		if applied[version] {
			return nil, fmt.Errorf("%w: duplicate version %s", apperrors.ErrMigrationValidation, version)
		}
		item, exists := known[version]

		if exists && (checksum == nil || *checksum != item.checksum || path.Base(filename) != path.Base(item.name)) {
			return nil, fmt.Errorf(
				"%w: checksum or filename mismatch for V%s (%s)",
				apperrors.ErrMigrationValidation,
				version,
				filename,
			)
		}
		applied[version] = true
	}
	if err = rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate migration history: %w", err)
	}
	return applied, nil
}

// Flyway equates V1, V01 and V1.0; installed extension versions may be dotted.
func historyVersion(value string) (string, error) {
	parts := strings.Split(strings.ReplaceAll(value, "_", "."), ".")
	for i, part := range parts {
		number, err := strconv.ParseInt(part, 10, 64)
		if err != nil || number < 0 {
			return "", fmt.Errorf("%w: unsupported history version %q", apperrors.ErrMigrationValidation, value)
		}
		parts[i] = strconv.FormatInt(number, 10)
	}
	for len(parts) > 1 && parts[len(parts)-1] == "0" {
		parts = parts[:len(parts)-1]
	}
	return strings.Join(parts, "."), nil
}
