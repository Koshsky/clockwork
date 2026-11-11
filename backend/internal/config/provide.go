package config

// ProvideConfig loads the application configuration.
func ProvideConfig() (*Config, error) { return Load() }

// ProvidePostgresConfig extracts the postgres settings.
func ProvidePostgresConfig(cfg *Config) PostgresConfig { return cfg.Postgres }

// ProvideJWTConfig extracts the JWT settings.
func ProvideJWTConfig(cfg *Config) JWTConfig { return cfg.JWT }

// ProvideProfilingConfig extracts the profiling settings.
func ProvideProfilingConfig(cfg *Config) ProfilingConfig { return cfg.Profiling }

// ProvideTracingConfig extracts the OpenTelemetry tracing settings.
func ProvideTracingConfig(cfg *Config) TracingConfig { return cfg.Tracing }

// ProvideRBACConfig extracts the RBAC settings.
func ProvideRBACConfig(cfg *Config) RBACConfig { return cfg.RBAC }

// ProvideRBACRefreshInterval extracts the RBAC rules refresh interval.
func ProvideRBACRefreshInterval(cfg *Config) Duration { return cfg.RBAC.RefreshInterval }

// ProvideAuditConfig extracts the audit-log capture settings (Loki storage).
func ProvideAuditConfig(cfg *Config) AuditConfig { return cfg.Audit }

// ProvideRedisConfig extracts the Redis settings (rate limiter backend, M1).
func ProvideRedisConfig(cfg *Config) RedisConfig { return cfg.Redis }

// ProvideSecurityConfig extracts the password-policy security settings.
func ProvideSecurityConfig(cfg *Config) SecurityConfig { return cfg.Security }
