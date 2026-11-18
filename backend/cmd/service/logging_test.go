package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestBootstrapFailuresAreStructured(t *testing.T) {
	t.Parallel()
	if scenario := os.Getenv("CLOCKWORK_BOOTSTRAP_TEST"); scenario != "" {
		version = "1.6.9"
		if scenario == "arguments" {
			//nolint:reassign // Only the isolated child changes argv to exercise the real CLI branch.
			os.Args = []string{"service", "migrate", "invalid"}
		}
		main()
		return
	}
	for _, tc := range []struct{ scenario, code string }{
		{"configuration", "CONFIGURATION_ERROR"}, {"arguments", "INVALID_ARGUMENTS"},
	} {
		t.Run(tc.scenario, func(t *testing.T) {
			t.Parallel()
			path := filepath.Join(t.TempDir(), "invalid.yaml")
			if err := os.WriteFile(path, []byte("canary-secret: ["), 0o600); err != nil {
				t.Fatal(err)
			}
			command := exec.CommandContext(t.Context(), os.Args[0], "-test.run=^TestBootstrapFailuresAreStructured$")
			command.Env = append(os.Environ(), "CLOCKWORK_BOOTSTRAP_TEST="+tc.scenario, "CONFIG_PATH="+path)
			var stdout, stderr bytes.Buffer
			command.Stdout, command.Stderr = &stdout, &stderr
			var exit *exec.ExitError
			if err := command.Run(); !errors.As(err, &exit) || exit.ExitCode() != 1 {
				t.Fatalf("bootstrap must fail before connecting: %v", err)
			}
			var event map[string]any
			if err := json.Unmarshal(stderr.Bytes(), &event); err != nil {
				t.Fatalf("bootstrap is not structured: %v, %s", err, stderr.String())
			}
			if event["error_code"] != tc.code || event["version"] != "1.6.9" ||
				event["component"] != "bootstrap" || event["level"] != "ERROR" ||
				strings.Contains(stderr.String(), "canary-") || stdout.Len() != 0 {
				t.Fatalf("incorrect bootstrap event: %v", event)
			}
		})
	}
}
