// Package release exposes metadata bundled with the running service.
package release

import (
	_ "embed"
	"strings"
)

//go:embed VERSION
var sourceVersion string

//go:embed Changelog_RU.md
var changelogRU string

//go:embed Changelog_ENG.md
var changelogEN string

// Info describes the service release independently of its deployment directory.
type Info struct {
	Version     string `json:"version"`
	ChangelogRU string `json:"changelog_ru"`
	ChangelogEN string `json:"changelog_en"`
}

// NewInfo preserves injected release versions and uses VERSION for local development.
func NewInfo(version string) *Info {
	if version == "" || version == "dev" {
		version = strings.TrimSpace(sourceVersion)
	}
	return &Info{Version: version, ChangelogRU: changelogRU, ChangelogEN: changelogEN}
}
