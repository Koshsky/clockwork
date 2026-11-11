// Package migrations ships only the immutable core schema, never deployment seeds.
package migrations

import (
	"embed"
	"io/fs"
)

//go:embed V*.sql
var core embed.FS

// Files returns the core SQL bundled into the service binary.
func Files() fs.FS {
	return core
}
