package ratelimit_test

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/Koshsky/erp-backend/internal/config"
	"github.com/Koshsky/erp-backend/internal/middleware/ratelimit"
)

// doRequestWithProxy serves a request as if it came through nginx: the direct
// peer (RemoteAddr) is the proxy IP inside trusted proxies, and remoteAddr is
// the real client IP that nginx appends to X-Forwarded-For. A spoofed
// X-Forwarded-For value the remote client may also supply is passed through.
func doRequestWithProxy(handler gin.HandlerFunc, proxyIP, remoteAddr, spoofedXFF string) *httptest.ResponseRecorder {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	_ = router.SetTrustedProxies([]string{proxyIP})
	router.Use(handler)
	router.Any("/test", func(c *gin.Context) {
		c.Status(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	req.RemoteAddr = proxyIP + ":443"
	if spoofedXFF != "" {
		req.Header.Set("X-Forwarded-For", spoofedXFF)
	}
	// nginx appends the real client IP to whatever X-Forwarded-For arrived.
	if xff := req.Header.Get("X-Forwarded-For"); xff != "" {
		req.Header.Set("X-Forwarded-For", xff+", "+remoteAddr)
	} else {
		req.Header.Set("X-Forwarded-For", remoteAddr)
	}
	req.Header.Set("X-Real-IP", remoteAddr)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

// TestRateLimitKeyIgnoresSpoofedForwardedFor guards against the proxy-trust
// bypass: while nginx is trusted, the limiter must key on the real client IP
// (appended by nginx), never on a client-supplied X-Forwarded-For value. A
// spoofed header must not grant a fresh token bucket per request.
func TestRateLimitKeyIgnoresSpoofedForwardedFor(t *testing.T) {
	t.Parallel()
	// The throttling assertions need a window (1/rate) longer than any
	// scheduler gap under parallel full-suite load; 0.1/s gives ~10s.
	cfg := config.RateLimitConfig{
		Enabled:           true,
		RequestsPerSecond: 0.1,
		Burst:             1,
		CleanupInterval:   config.Duration(time.Minute),
		Expiration:        config.Duration(time.Minute),
	}
	handler := ratelimit.FromConfig(cfg, nil)
	nginxIP := "172.18.0.2"
	realClient := "203.0.113.7"

	// Every request carries a different spoofed X-Forwarded-For head; all must
	// still map to the same real client bucket and hit the 1-burst limit.
	if rec := doRequestWithProxy(handler, nginxIP, realClient, "1.1.1.1"); rec.Code != http.StatusOK {
		t.Fatalf("first request status = %d, want %d", rec.Code, http.StatusOK)
	}
	if rec := doRequestWithProxy(handler, nginxIP, realClient, "2.2.2.2"); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("second request (spoofed X-Forwarded-For) status = %d, want %d", rec.Code, http.StatusTooManyRequests)
	}

	// A genuinely different real client behind the same proxy gets its own bucket.
	if rec := doRequestWithProxy(handler, nginxIP, "203.0.113.8", "9.9.9.9"); rec.Code != http.StatusOK {
		t.Fatalf("different real client status = %d, want %d", rec.Code, http.StatusOK)
	}
}

// TestCustomKeyFuncBucketing verifies that a custom KeyFunc (e.g. keying by
// user id instead of IP) controls the bucket identity: the same key shares one
// bucket, a different key gets its own.
func TestCustomKeyFuncBucketing(t *testing.T) {
	t.Parallel()
	cfg := config.RateLimitConfig{
		Enabled:           true,
		RequestsPerSecond: 0.1,
		Burst:             1,
		CleanupInterval:   config.Duration(time.Minute),
		Expiration:        config.Duration(time.Minute),
	}

	handler := ratelimit.FromConfigKeyed(cfg, func(c *gin.Context) string {
		return c.GetHeader("X-User-Id")
	}, nil)

	// Same key ("alice") twice -> second hits the 1-burst limit.
	if rec := doRequestWithHeader(handler, "alice"); rec.Code != http.StatusOK {
		t.Fatalf("alice first status = %d, want %d", rec.Code, http.StatusOK)
	}
	if rec := doRequestWithHeader(handler, "alice"); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("alice repeat status = %d, want %d", rec.Code, http.StatusTooManyRequests)
	}

	// Different key ("bob") gets its own bucket.
	if rec := doRequestWithHeader(handler, "bob"); rec.Code != http.StatusOK {
		t.Fatalf("bob first status = %d, want %d", rec.Code, http.StatusOK)
	}
}

func doRequestWithHeader(handler gin.HandlerFunc, userID string) *httptest.ResponseRecorder {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(handler)
	router.Any("/test", func(c *gin.Context) {
		c.Status(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	req.Header.Set("X-User-Id", userID)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func doRequest(handler gin.HandlerFunc, clientIP string) *httptest.ResponseRecorder {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(handler)
	router.Any("/test", func(c *gin.Context) {
		c.Status(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	req.RemoteAddr = clientIP
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func TestAllowsRequestsWithinLimit(t *testing.T) {
	t.Parallel()
	cfg := config.RateLimitConfig{
		Enabled:           true,
		RequestsPerSecond: 10,
		Burst:             5,
		CleanupInterval:   config.Duration(time.Minute),
		Expiration:        config.Duration(time.Minute),
	}

	handler := ratelimit.FromConfig(cfg, nil)

	for i := range 5 {
		rec := doRequest(handler, "192.168.0.1:1234")
		if rec.Code != http.StatusOK {
			t.Fatalf("request %d status = %d, want %d", i+1, rec.Code, http.StatusOK)
		}
	}
}

func TestRejectsRequestsOverBurst(t *testing.T) {
	t.Parallel()
	cfg := config.RateLimitConfig{
		Enabled:           true,
		RequestsPerSecond: 0.1,
		Burst:             2,
		CleanupInterval:   config.Duration(time.Minute),
		Expiration:        config.Duration(time.Minute),
	}

	handler := ratelimit.FromConfig(cfg, nil)

	for i := range 3 {
		rec := doRequest(handler, "192.168.0.2:1234")
		if i < 2 && rec.Code != http.StatusOK {
			t.Fatalf("request %d status = %d, want %d", i+1, rec.Code, http.StatusOK)
		}
		if i == 2 && rec.Code != http.StatusTooManyRequests {
			t.Fatalf("request %d status = %d, want %d", i+1, rec.Code, http.StatusTooManyRequests)
		}
		if i == 2 && rec.Header().Get("Retry-After") != "1" {
			t.Errorf("Retry-After = %q, want \"1\"", rec.Header().Get("Retry-After"))
		}
	}
}

func TestLimitIsPerClient(t *testing.T) {
	t.Parallel()
	cfg := config.RateLimitConfig{
		Enabled:           true,
		RequestsPerSecond: 0.1,
		Burst:             1,
		CleanupInterval:   config.Duration(time.Minute),
		Expiration:        config.Duration(time.Minute),
	}

	handler := ratelimit.FromConfig(cfg, nil)

	if rec := doRequest(handler, "192.168.0.3:1234"); rec.Code != http.StatusOK {
		t.Fatalf("first client request status = %d, want %d", rec.Code, http.StatusOK)
	}
	if rec := doRequest(handler, "192.168.0.3:1234"); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("first client repeat status = %d, want %d", rec.Code, http.StatusTooManyRequests)
	}
	if rec := doRequest(handler, "192.168.0.4:1234"); rec.Code != http.StatusOK {
		t.Fatalf("second client request status = %d, want %d", rec.Code, http.StatusOK)
	}
}

func TestDisabledConfigPassesEverything(t *testing.T) {
	t.Parallel()
	cfg := config.RateLimitConfig{Enabled: false}

	handler := ratelimit.FromConfig(cfg, nil)

	for i := range 10 {
		rec := doRequest(handler, "192.168.0.5:1234")
		if rec.Code != http.StatusOK {
			t.Fatalf("request %d status = %d, want %d", i+1, rec.Code, http.StatusOK)
		}
	}
}

// TestInvalidEnabledConfigFailsClosed guards against the silent-disable and
// hard-block misconfigurations: an enabled rate limit with requests_per_second
// <= 0 or burst <= 0 must fail loudly at construction (config.Load rejects the
// values at startup; the constructor guard panics) instead of silently turning
// the wall off or 429ing everyone.
func TestInvalidEnabledConfigFailsClosed(t *testing.T) {
	t.Parallel()
	cases := []config.RateLimitConfig{
		{Enabled: true, RequestsPerSecond: 0},
		{Enabled: true, RequestsPerSecond: 10, Burst: 0},
	}
	for _, cfg := range cases {
		func() {
			defer func() {
				if recover() == nil {
					t.Fatalf("expected panic for enabled limit %+v", cfg)
				}
			}()
			ratelimit.FromConfig(cfg, nil)
		}()
	}
}
