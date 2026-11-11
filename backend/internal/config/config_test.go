package config_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Koshsky/erp-backend/internal/config"
)

// writeConfig writes a minimal config.yaml into a temp dir and returns its path.
func writeConfig(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// TestLoadRejectsInvalidRateLimit guards against the silent-disable/hard-block
// misconfigurations (I9): an enabled rate limit with requests_per_second <= 0
// or burst <= 0 must fail startup with a clear error instead of silently
// disabling the wall or 429ing every request. Setenv is required because the
// test drives the real Load() entrypoint.
func TestLoadRejectsInvalidRateLimit(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://test")
	t.Setenv("JWT_SECRET_KEY", "12345678901234567890123456789012")

	for _, tc := range []struct {
		name string
		yaml string
		want string
	}{
		{
			name: "public limit with zero requests_per_second",
			yaml: "rate_limiting:\n  enabled: true\n  requests_per_second: 0\n  burst: 20\n",
			want: "requests_per_second",
		},
		{
			name: "public limit with zero burst",
			yaml: "rate_limiting:\n  enabled: true\n  requests_per_second: 20\n  burst: 0\n",
			want: "burst",
		},
		{
			name: "user limit with zero requests_per_second",
			yaml: "user_rate_limiting:\n  enabled: true\n  requests_per_second: 0\n  burst: 20\n",
			want: "requests_per_second",
		},
		{
			name: "user limit with zero burst",
			yaml: "user_rate_limiting:\n  enabled: true\n  requests_per_second: 20\n  burst: 0\n",
			want: "burst",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("CONFIG_PATH", writeConfig(t, tc.yaml))
			_, err := config.Load()
			if err == nil {
				t.Fatal("expected an error for the invalid rate limit config")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %q, want it to mention %q", err, tc.want)
			}
		})
	}
}

// TestLoadAllowsDisabledRateLimits checks the disabled path: rate limit blocks
// that are off are not validated, so zero values pass without an error.
func TestLoadAllowsDisabledRateLimits(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://test")
	t.Setenv("JWT_SECRET_KEY", "12345678901234567890123456789012")
	t.Setenv("CONFIG_PATH", writeConfig(t, "rate_limiting:\n  enabled: false\nuser_rate_limiting:\n  enabled: false\n"))

	if _, err := config.Load(); err != nil {
		t.Fatalf("Load() error = %v, want nil for disabled rate limits", err)
	}
}

// TestLoadEnvEndpointOverrides checks the dev-mode env overrides that point a
// host-run binary (air) at the published ports of the in-docker infra
// (TRACING_ENDPOINT / REDIS_ADDRESS / AUDIT_URL): each overrides the matching
// config.yaml value when set and falls back to the file value when empty.
func TestLoadEnvEndpointOverrides(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://test")
	t.Setenv("JWT_SECRET_KEY", "12345678901234567890123456789012")

	const yaml = "tracing:\n  enabled: true\n  exporter_endpoint: jaeger:4317\nredis:\n  enabled: true\n  address: redis:6379\naudit:\n  enabled: true\n  url: http://loki:3100\n"

	t.Run("set overrides the yaml value", func(t *testing.T) {
		t.Setenv("CONFIG_PATH", writeConfig(t, yaml))
		t.Setenv("TRACING_ENDPOINT", "localhost:4317")
		t.Setenv("REDIS_ADDRESS", "localhost:6379")
		t.Setenv("AUDIT_URL", "http://localhost:3100")

		cfg, err := config.Load()
		if err != nil {
			t.Fatalf("Load() error = %v", err)
		}
		if cfg.Tracing.ExporterEndpoint != "localhost:4317" {
			t.Errorf("ExporterEndpoint = %q, want localhost:4317", cfg.Tracing.ExporterEndpoint)
		}
		if cfg.Redis.Address != "localhost:6379" {
			t.Errorf("Redis.Address = %q, want localhost:6379", cfg.Redis.Address)
		}
		if cfg.Audit.URL != "http://localhost:3100" {
			t.Errorf("Audit.URL = %q, want http://localhost:3100", cfg.Audit.URL)
		}
	})

	t.Run("unset keeps the yaml value", func(t *testing.T) {
		t.Setenv("CONFIG_PATH", writeConfig(t, yaml))
		t.Setenv("TRACING_ENDPOINT", "")
		t.Setenv("REDIS_ADDRESS", "")
		t.Setenv("AUDIT_URL", "")

		cfg, err := config.Load()
		if err != nil {
			t.Fatalf("Load() error = %v", err)
		}
		if cfg.Tracing.ExporterEndpoint != "jaeger:4317" {
			t.Errorf("ExporterEndpoint = %q, want jaeger:4317", cfg.Tracing.ExporterEndpoint)
		}
		if cfg.Redis.Address != "redis:6379" {
			t.Errorf("Redis.Address = %q, want redis:6379", cfg.Redis.Address)
		}
		if cfg.Audit.URL != "http://loki:3100" {
			t.Errorf("Audit.URL = %q, want http://loki:3100", cfg.Audit.URL)
		}
	})
}
