package release_test

import (
	"os"
	"strings"
	"testing"

	release "github.com/Koshsky/erp-backend"
)

func TestDevelopmentVersionUsesCanonicalSource(t *testing.T) {
	t.Parallel()

	version, err := os.ReadFile("VERSION")
	if err != nil {
		t.Fatal(err)
	}

	for _, injected := range []string{"", "dev"} {
		info := release.NewInfo(injected)
		if info.Version != strings.TrimSpace(string(version)) {
			t.Fatalf("injected %q: version = %q", injected, info.Version)
		}
	}
}
