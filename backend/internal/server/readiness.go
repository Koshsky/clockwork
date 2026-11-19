package server

import (
	"context"
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	"github.com/Koshsky/erp-backend/internal/migration"
	"github.com/Koshsky/erp-backend/internal/response"
)

const (
	readinessTimeout = 500 * time.Millisecond
	readinessTTL     = time.Second
)

type readinessDB interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

type readinessProbe struct {
	db       readinessDB
	expected int64
	gate     chan struct{}
	mu       sync.Mutex
	until    time.Time
	ready    bool
}

func newReadiness(db readinessDB) *readinessProbe {
	version, _ := migration.CoreVersion()
	return &readinessProbe{db: db, expected: version, gate: make(chan struct{}, 1)}
}

func (p *readinessProbe) check(parent context.Context) bool {
	if p == nil || p.db == nil || p.expected <= 0 || parent.Err() != nil {
		return false
	}
	p.mu.Lock()
	cached, valid := p.ready, time.Now().Before(p.until)
	p.mu.Unlock()
	if valid {
		return cached
	}
	select {
	case p.gate <- struct{}{}:
		defer func() { <-p.gate }()
	default:
		return false
	}
	ctx, cancel := context.WithTimeout(parent, readinessTimeout)
	defer cancel()
	var ready bool
	err := p.db.QueryRow(ctx, `SELECT count(*) = 1 AND coalesce(bool_and(version = $1 AND NOT dirty), false)
FROM schema_migrations`, p.expected).Scan(&ready)
	if parent.Err() == nil {
		p.mu.Lock()
		p.ready, p.until = err == nil && ready, time.Now().Add(readinessTTL)
		p.mu.Unlock()
	}
	return err == nil && ready
}

// registerProbes keeps connectivity/readiness outside all application token buckets.
func (a *App) registerProbes(router *gin.Engine) {
	router.GET("/api/v1/health", a.health)
	router.GET("/api/v1/ready", a.ready)
}

// ready deliberately discloses no database, schema, credential or auxiliary state.
func (a *App) ready(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	status, state := http.StatusServiceUnavailable, "not_ready"
	if a.readiness.check(c.Request.Context()) {
		status, state = http.StatusOK, "ready"
	}
	c.JSON(status, response.SuccessResponse{Data: gin.H{"status": state}, Error: gin.H{}})
}
