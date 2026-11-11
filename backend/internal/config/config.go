// Package config — application configuration.
//
// Non-secret settings are read from config.yaml (the path is set by the
// CONFIG_PATH environment variable, defaulting to ./config.yaml). Secrets and
// the DB URL come only from environment variables: DATABASE_URL, JWT_SECRET_KEY,
// JWT_REFRESH_KEY (legacy-optional, see applyEnv).
package config

import (
	"fmt"
	"os"
	"time"

	"gopkg.in/yaml.v3"
)

// Duration is a Go-formatted duration (e.g., "15s", "30m") from YAML.
type Duration time.Duration

// UnmarshalYAML parses a duration string into [Duration].
func (d *Duration) UnmarshalYAML(node *yaml.Node) error {
	parsed, err := time.ParseDuration(node.Value)
	if err != nil {
		return fmt.Errorf("invalid duration %q: %w", node.Value, err)
	}
	*d = Duration(parsed)
	return nil
}

// Config is the root application configuration.
type Config struct {
	HTTPServer HTTPServerConfig `yaml:"server"`
	Postgres   PostgresConfig   `yaml:"postgres"`
	JWT        JWTConfig        `yaml:"jwt"`
	Logging    LoggingConfig    `yaml:"logging"`
	Swagger    SwaggerConfig    `yaml:"swagger"`
	CORS       CORSConfig       `yaml:"cors"`
	RateLimit  RateLimitConfig  `yaml:"rate_limiting"`
	// UserRateLimit is the per authenticated user limit for protected routes.
	UserRateLimit RateLimitConfig `yaml:"user_rate_limiting"`
	Redis         RedisConfig     `yaml:"redis"`
	Profiling     ProfilingConfig `yaml:"profiling"`
	Tracing       TracingConfig   `yaml:"tracing"`
	RBAC          RBACConfig      `yaml:"rbac"`
	Audit         AuditConfig     `yaml:"audit"`
	Security      SecurityConfig  `yaml:"security"`
	// Admin holds the bootstrap administrator credentials. The login is a code
	// invariant ("admin", see user service); the password comes only from the
	// ADMIN_PASSWORD environment variable.
	Admin AdminConfig `yaml:"-"`
}

// AdminConfig — the bootstrap administrator account (see EnsureAdmin).
type AdminConfig struct {
	// Password creates the admin account on the first launch. It is never
	// stored in config.yaml, never logged and never rotated by the bootstrap.
	Password string `yaml:"-"`
}

// SecurityConfig — password policy extras.
type SecurityConfig struct {
	Password PasswordSecurityConfig `yaml:"password"`
}

// PasswordSecurityConfig — password validation options.
type PasswordSecurityConfig struct {
	// HIBP — optional Have I Been Pwned breach check (k-anonymity range API).
	HIBP HIBPConfig `yaml:"hibp"`
}

// HIBPConfig — breach-feed check settings. Best-effort: network failures
// skip the check; the local policy always applies.
type HIBPConfig struct {
	Enabled bool     `yaml:"enabled"`
	Timeout Duration `yaml:"timeout"`
}

// RBACConfig — runtime-RBAC settings (rules reload from the DB).
type RBACConfig struct {
	// RefreshInterval — the background rule reload period from Postgres
	// (eventual consistency between instances; local edits
	// apply immediately).
	RefreshInterval Duration `yaml:"refresh_interval"`
}

// HTTPServerConfig is the HTTP server settings.
type HTTPServerConfig struct {
	Port         int      `yaml:"port"`
	ReadTimeout  Duration `yaml:"read_timeout"`
	WriteTimeout Duration `yaml:"write_timeout"`
	IdleTimeout  Duration `yaml:"idle_timeout"`
	// MaxBodyBytes is the per-request body size limit (bytes); larger bodies
	// are rejected with a 400-class error (H3 — DoS protection).
	MaxBodyBytes int64 `yaml:"max_body_bytes"`
	// RequestTimeout is the per-request context timeout (H3): the handler
	// context is canceled after this duration, aborting long DB queries
	// (planning/calendar aggregates) so goroutines and pool connections are
	// released. Must be lower than WriteTimeout to take effect.
	RequestTimeout Duration `yaml:"request_timeout"`
	// TrustedProxies is the CIDR/client networks allowed to forward client IP
	// headers (X-Forwarded-For / X-Real-IP) to the backend. It MUST list only
	// the reverse proxy (nginx) networks; trusting all networks lets remote
	// clients spoof their IP and bypass per-IP rate limiting.
	TrustedProxies []string `yaml:"trusted_proxies"`
}

// PostgresConfig is the Postgres connection pool settings.
//
// URL comes from the DATABASE_URL environment variable (yaml:"-").
type PostgresConfig struct {
	URL               string   `yaml:"-"`
	MaxConns          int32    `yaml:"max_conns"`
	MinConns          int32    `yaml:"min_conns"`
	MaxConnLifetime   Duration `yaml:"max_conn_lifetime"`
	MaxConnIdleTime   Duration `yaml:"max_conn_idle_time"`
	HealthCheckPeriod Duration `yaml:"health_check_period"`
	ConnectTimeout    Duration `yaml:"connect_timeout"`
}

// JWTConfig is the JWT settings.
//
// Secrets come from environment variables (yaml:"-").
type JWTConfig struct {
	SecretKey string `yaml:"-"`
	// RefreshKey remains legacy-compatible: refresh tokens are opaque and stored
	// in the DB (AD-06); the key is only kept in the environment.
	RefreshKey          string   `yaml:"-"`
	AccessExpiry        Duration `yaml:"access_expiry"`
	RefreshExpiry       Duration `yaml:"refresh_expiry"`
	Issuer              string   `yaml:"issuer"`
	RefreshCookieSecure bool     `yaml:"refresh_cookie_secure"`
}

// LoggingConfig is the logging settings.
type LoggingConfig struct {
	Level  string `yaml:"level"`
	Format string `yaml:"format"`
}

// SwaggerConfig is the embedded Swagger UI settings.
type SwaggerConfig struct {
	Enabled bool `yaml:"enabled"`
}

// CORSConfig is the Cross-Origin Resource Sharing settings.
type CORSConfig struct {
	AllowOrigins     []string `yaml:"allow_origins"`
	AllowMethods     []string `yaml:"allow_methods"`
	AllowHeaders     []string `yaml:"allow_headers"`
	ExposeHeaders    []string `yaml:"expose_headers"`
	AllowCredentials bool     `yaml:"allow_credentials"`
	MaxAge           Duration `yaml:"max_age"`
}

// ProfilingConfig is the pprof server settings.
type ProfilingConfig struct {
	Enabled bool   `yaml:"enabled"`
	Address string `yaml:"address"`
}

// TracingConfig — OpenTelemetry distributed tracing settings (OTLP/gRPC
// exporter, by default the in-stack Jaeger collector).
type TracingConfig struct {
	Enabled          bool    `yaml:"enabled"`
	ExporterEndpoint string  `yaml:"exporter_endpoint"`
	ServiceName      string  `yaml:"service_name"`
	SamplerRatio     float64 `yaml:"sampler_ratio"`
}

// AuditConfig — audit-log capture settings. Events are pushed to Grafana Loki
// (the log-storage service) over its HTTP API.
type AuditConfig struct {
	Enabled bool `yaml:"enabled"`
	// URL is the Grafana Loki base URL (in the docker network, e.g.
	// http://loki:3100). No auth: Loki runs inside the app-network with
	// auth_enabled disabled.
	URL     string   `yaml:"url"`
	Timeout Duration `yaml:"timeout"`
	// Sync sends events synchronously inside the request (strict durability,
	// slower; a single attempt bounded by a short per-send budget so the
	// request never stalls on a down Loki); the default async mode buffers
	// events and retries off the request goroutine.
	Sync bool `yaml:"sync"`
}

// RateLimitConfig is the per-client rate limiting settings.
type RateLimitConfig struct {
	Enabled           bool     `yaml:"enabled"`
	RequestsPerSecond float64  `yaml:"requests_per_second"`
	Burst             int      `yaml:"burst"`
	CleanupInterval   Duration `yaml:"cleanup_interval"`
	Expiration        Duration `yaml:"expiration"`
}

// RedisConfig is the shared Redis connection settings. Redis backs the rate
// limiter (M1): the backend is chosen explicitly by config — when enabled,
// token buckets are shared across instances and an unreachable Redis fails
// application startup (fail-fast); when disabled, the limiter uses the
// in-memory implementation. Credentials are non-secret infra settings (prod
// may add an optional REDIS_PASSWORD-style env override later).
type RedisConfig struct {
	Enabled      bool     `yaml:"enabled"`
	Address      string   `yaml:"address"`
	Password     string   `yaml:"password"`
	DB           int      `yaml:"db"`
	DialTimeout  Duration `yaml:"dial_timeout"`
	ReadTimeout  Duration `yaml:"read_timeout"`
	WriteTimeout Duration `yaml:"write_timeout"`
	PoolSize     int      `yaml:"pool_size"`
	// KeyPrefix namespaces all Redis keys owned by the application.
	KeyPrefix string `yaml:"key_prefix"`
}

// Load loads the configuration: config.yaml plus secrets from environment variables.
func Load() (*Config, error) {
	path := getEnv("CONFIG_PATH", "config.yaml")

	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config file %s: %w", path, err)
	}

	var cfg Config
	if parseErr := yaml.Unmarshal(raw, &cfg); parseErr != nil {
		return nil, fmt.Errorf("parse config file %s: %w", path, parseErr)
	}

	if envErr := applyEnv(&cfg); envErr != nil {
		return nil, envErr
	}

	if validErr := validate(&cfg); validErr != nil {
		return nil, validErr
	}

	return &cfg, nil
}

// validate enforces the invariants a disabled configuration cannot express by
// itself: an enabled rate limit must carry positive requests_per_second and
// burst, or the middleware would silently disable itself (requests_per_second
// <= 0) or hard-block every request (burst <= 0) without any startup warning.
func validate(cfg *Config) error {
	for name, limit := range map[string]RateLimitConfig{
		"rate_limiting":      cfg.RateLimit,
		"user_rate_limiting": cfg.UserRateLimit,
	} {
		if !limit.Enabled {
			continue
		}
		if limit.RequestsPerSecond <= 0 {
			return fmt.Errorf("%s: requests_per_second must be > 0 when rate limiting is enabled", name)
		}
		if limit.Burst <= 0 {
			return fmt.Errorf("%s: burst must be > 0 when rate limiting is enabled", name)
		}
	}
	return nil
}

// minJWTSecretLen is the minimum accepted length of JWT_SECRET_KEY (256-bit
// equivalent in ASCII hex; shorter keys weaken HMAC-SHA256 signatures).
const minJWTSecretLen = 32

// applyEnv applies secrets and the DB URL from environment variables to the configuration.
func applyEnv(cfg *Config) error {
	cfg.Postgres.URL = getEnv("DATABASE_URL", "")
	if cfg.Postgres.URL == "" {
		return fmt.Errorf("DATABASE_URL is required")
	}

	cfg.JWT.SecretKey = getEnv("JWT_SECRET_KEY", "")
	if cfg.JWT.SecretKey == "" {
		return fmt.Errorf("JWT_SECRET_KEY is required")
	}
	if len(cfg.JWT.SecretKey) < minJWTSecretLen {
		return fmt.Errorf("JWT_SECRET_KEY must be at least %d characters", minJWTSecretLen)
	}

	cfg.JWT.RefreshKey = getEnv("JWT_REFRESH_KEY", "")
	// JWT_REFRESH_KEY is legacy (AD-06): refresh tokens are opaque and stored
	// in the DB, the key is never used. It is read for compatibility but is no
	// longer required on startup (L8).

	// ADMIN_PASSWORD bootstraps the administrator account on the first launch
	// (the login is the fixed code invariant "admin"). It is not validated
	// here: the bootstrap knows whether the account already exists, and only a
	// missing account with a missing password is an error.
	cfg.Admin.Password = getEnv("ADMIN_PASSWORD", "")

	// TRACING_ENDPOINT overrides the OTLP exporter endpoint (dev: host-run air
	// reaches the in-docker Jaeger collector via its published port; kept empty
	// in the full-stack docker run, which uses the in-network "jaeger:4317").
	if endpoint := getEnv("TRACING_ENDPOINT", ""); endpoint != "" {
		cfg.Tracing.ExporterEndpoint = endpoint
	}

	// REDIS_ADDRESS overrides the Redis endpoint (dev: host-run air reaches
	// the in-docker Redis service via its published port; kept empty in the
	// full-stack docker run, which uses the in-network "redis:6379").
	if address := getEnv("REDIS_ADDRESS", ""); address != "" {
		cfg.Redis.Address = address
	}

	// AUDIT_URL overrides the Loki base URL (dev: host-run air reaches the
	// in-docker Loki service via its published port; kept empty in the
	// full-stack docker run, which uses the in-network "http://loki:3100").
	if url := getEnv("AUDIT_URL", ""); url != "" {
		cfg.Audit.URL = url
	}

	return nil
}
