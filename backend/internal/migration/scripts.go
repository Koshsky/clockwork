// Package migration embeds core SQL and validates legacy history for explicit adoption.
package migration

import (
	"bytes"
	"fmt"
	"hash/crc32"
	"io/fs"
	"path"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	apperrors "github.com/Koshsky/erp-backend/internal/errors"
)

type script struct {
	version     int64
	name        string
	description string
	body        string
	checksum    int64
}

func loadScripts(sources []fs.FS) ([]script, error) {
	out := make([]script, 0)
	seen := make(map[int64]string)
	for _, source := range sources {
		err := fs.WalkDir(source, ".", func(name string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if entry.IsDir() || !strings.HasSuffix(name, ".sql") {
				return nil
			}
			item, err := readScript(source, name)
			if err != nil {
				return err
			}
			if previous, exists := seen[item.version]; exists {
				return fmt.Errorf(
					"%w: duplicate version %d (%s, %s)",
					apperrors.ErrMigrationValidation,
					item.version,
					previous,
					name,
				)
			}
			seen[item.version] = name
			out = append(out, *item)
			return nil
		})
		if err != nil {
			return nil, fmt.Errorf("read migrations: %w", err)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].version < out[j].version })
	if len(out) == 0 {
		return nil, fmt.Errorf("%w: no SQL files", apperrors.ErrMigrationValidation)
	}
	return out, nil
}

func readScript(source fs.FS, name string) (*script, error) {
	versionText, description, found := strings.Cut(strings.TrimSuffix(path.Base(name), ".sql"), "__")
	version, err := strconv.ParseInt(strings.TrimPrefix(versionText, "V"), 10, 64)
	if !found || !strings.HasPrefix(versionText, "V") || err != nil || version <= 0 || description == "" {
		return nil, fmt.Errorf(
			"%w: unsupported filename %s (expected V<number>__description.sql)",
			apperrors.ErrMigrationValidation,
			name,
		)
	}
	body, err := fs.ReadFile(source, name)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", name, err)
	}
	if !utf8.Valid(body) {
		return nil, fmt.Errorf("%w: %s is not UTF-8", apperrors.ErrMigrationValidation, name)
	}
	body = bytes.TrimPrefix(body, []byte{0xef, 0xbb, 0xbf})
	return &script{
		version:     version,
		name:        name,
		description: strings.ReplaceAll(description, "_", " "),
		body:        string(body),
		checksum:    flywayChecksum(body),
	}, nil
}

// Flyway 9 calculates signed CRC32 over UTF-8 lines without BOM or line endings.
func flywayChecksum(body []byte) int64 {
	body = bytes.TrimPrefix(body, []byte{0xef, 0xbb, 0xbf})
	body = bytes.ReplaceAll(body, []byte("\r"), nil)
	body = bytes.ReplaceAll(body, []byte("\n"), nil)
	value := int64(crc32.ChecksumIEEE(body))
	if value > 1<<31-1 {
		const checksumBits = 32
		value -= 1 << checksumBits
	}
	return value
}
