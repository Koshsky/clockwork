package ratelimit_test

import (
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"

	"github.com/Koshsky/erp-backend/internal/config"
	"github.com/Koshsky/erp-backend/internal/middleware/ratelimit"
)

// newRedisProvider builds a Provider over miniredis with a discard logger.
func newRedisProvider(t *testing.T) (*ratelimit.Provider, *miniredis.Miniredis) {
	t.Helper()
	mr := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	return ratelimit.ProvideProvider(client, config.RedisConfig{
		Enabled:   true,
		KeyPrefix: "test:rl",
	}, slog.New(slog.DiscardHandler)), mr
}

// runProvider executes the provider-built middleware once and returns the
// status and Retry-After header.
func runProvider(handler gin.HandlerFunc) (int, string) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(handler)
	r.GET("/probe", func(c *gin.Context) { c.Status(http.StatusOK) })

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/probe", nil))
	return w.Code, w.Header().Get("Retry-After")
}

// TestRedisLimiterBurstableAndBlocked checks the token bucket semantics: a
// burst of requests passes, the next one is throttled with Retry-After.
//
// The Lua script reads the current time from Redis TIME, so the test drives
// refills deterministically through miniredis.SetTime: the bucket math only
// sees the frozen clock, never real elapsed time. This keeps the assertions
// exact even when the full suite runs in parallel under load (the previous
// version measured real time and flaked with a too-slow scheduler gap between
// requests, e.g. "want 429" after the burst drained on a fresh key).
func TestRedisLimiterBurstableAndBlocked(t *testing.T) {
	t.Parallel()
	provider, mr := newRedisProvider(t)
	handler := provider.New(ratelimit.Config{
		RequestsPerSecond: 1,
		Burst:             2,
		Expiration:        5 * time.Minute,
	})

	base := time.Now().UTC().Truncate(time.Millisecond)
	mr.SetTime(base)

	// Burst of two at the same frozen moment: the second passes because the
	// bucket starts full (no refill wait needed for the initial tokens).
	for i := range 2 {
		status, _ := runProvider(handler)
		if status != http.StatusOK {
			t.Fatalf("request %d: status = %d, want 200", i+1, status)
		}
	}

	// Half a second later at 1 token/s the bucket has only ~0.5 tokens —
	// deterministically below the threshold, so a 429 is guaranteed.
	mr.SetTime(base.Add(500 * time.Millisecond))
	status, retryAfter := runProvider(handler)
	if status != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", status)
	}
	if retryAfter == "" {
		t.Fatal("Retry-After header is missing")
	}

	keys := mr.Keys()
	if len(keys) != 1 {
		t.Fatalf("redis keys = %v, want exactly one bucket key", keys)
	}
}

// TestRedisLimiterBurstOne checks the strictest configuration: with burst == 1
// every request after the first is throttled until a token refills. The first
// request passing at the frozen bucket-creation moment also proves the initial
// state of a fresh key is a full bucket.
func TestRedisLimiterBurstOne(t *testing.T) {
	t.Parallel()
	provider, mr := newRedisProvider(t)
	handler := provider.New(ratelimit.Config{
		RequestsPerSecond: 1,
		Burst:             1,
		Expiration:        5 * time.Minute,
	})

	base := time.Now().UTC().Truncate(time.Millisecond)
	mr.SetTime(base)

	if status, _ := runProvider(handler); status != http.StatusOK {
		t.Fatalf("first request (full bucket): status = %d, want 200", status)
	}
	// Both follow-ups arrive before a token refills: the bucket holds 0 tokens
	// from the first request, so every subsequent one must be throttled.
	for i := range 2 {
		status, retryAfter := runProvider(handler)
		if status != http.StatusTooManyRequests {
			t.Fatalf("request %d after drain: status = %d, want 429", i+2, status)
		}
		if retryAfter == "" {
			t.Fatalf("request %d: Retry-After header is missing", i+2)
		}
	}

	if len(mr.Keys()) != 1 {
		t.Fatalf("redis keys = %v, want exactly one bucket key", mr.Keys())
	}
}

// TestRedisLimiterRefills checks that time passing refills the bucket. The
// script reads Redis TIME, so the test drives the refill deterministically
// through miniredis.SetTime (FastForward does not advance the TIME command,
// which is exactly why SetTime is used here).
func TestRedisLimiterRefills(t *testing.T) {
	t.Parallel()
	provider, mr := newRedisProvider(t)
	handler := provider.New(ratelimit.Config{
		RequestsPerSecond: 100,
		Burst:             1,
		Expiration:        5 * time.Minute,
	})

	base := time.Now().UTC().Truncate(time.Millisecond)
	mr.SetTime(base)

	if status, _ := runProvider(handler); status != http.StatusOK {
		t.Fatalf("first request: status = %d, want 200", status)
	}
	// 5ms later the bucket has only half a token at 100 tokens/s — still 429.
	mr.SetTime(base.Add(5 * time.Millisecond))
	if status, _ := runProvider(handler); status != http.StatusTooManyRequests {
		t.Fatalf("second request: status = %d, want 429", status)
	}
	// 15ms (>= 1 token at 100/s) later the bucket has refilled: deterministically 200.
	mr.SetTime(base.Add(15 * time.Millisecond))
	if status, _ := runProvider(handler); status != http.StatusOK {
		t.Fatalf("request after refill: status = %d, want 200", status)
	}
}

// TestRedisLimiterKeyedByClientIP checks keys are scoped per IP (default key).
func TestRedisLimiterKeyedByClientIP(t *testing.T) {
	t.Parallel()
	provider, mr := newRedisProvider(t)
	handler := provider.New(ratelimit.Config{
		RequestsPerSecond: 1,
		Burst:             1,
		Expiration:        5 * time.Minute,
	})

	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(handler)
	r.GET("/probe", func(c *gin.Context) { c.Status(http.StatusOK) })

	base := time.Now().UTC().Truncate(time.Millisecond)
	mr.SetTime(base)

	newReq := func(ip string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/probe", nil)
		req.RemoteAddr = ip + ":1234"
		r.ServeHTTP(w, req)
		return w
	}

	// Same IP, same frozen moment: first passes (fresh full bucket), the second
	// arrives before a refill and is throttled.
	if newReq("10.0.0.1").Code != http.StatusOK {
		t.Fatal("first request from 10.0.0.1: want 200")
	}
	if newReq("10.0.0.1").Code != http.StatusTooManyRequests {
		t.Fatal("second request from 10.0.0.1: want 429")
	}
	// Different IP has its own bucket → passes regardless of the other key.
	if newReq("10.0.0.2").Code != http.StatusOK {
		t.Fatal("request from 10.0.0.2: want 200")
	}

	if len(mr.Keys()) != 2 {
		t.Fatalf("redis keys = %v, want two per-IP buckets", mr.Keys())
	}
}

// TestRedisLimiterDisabledNoop checks disabled limits short-circuit.
func TestRedisLimiterDisabledNoop(t *testing.T) {
	t.Parallel()
	provider, _ := newRedisProvider(t)
	handler := provider.FromConfig(config.RateLimitConfig{Enabled: false})
	if status, _ := runProvider(handler); status != http.StatusOK {
		t.Fatalf("status = %d, want 200", status)
	}
}

// TestProviderMemoryFallback checks the in-memory path when Redis is nil. The
// in-memory bucket uses real wall-clock time, so the throttling assertions get
// a very low refill rate: the window in which the drained bucket may not
// refill is ~100s, making the test immune to scheduler gaps under load.
func TestProviderMemoryFallback(t *testing.T) {
	t.Parallel()
	provider := ratelimit.ProvideProvider(nil, config.RedisConfig{KeyPrefix: "x"}, slog.New(slog.DiscardHandler))
	handler := provider.New(ratelimit.Config{
		RequestsPerSecond: 0.01,
		Burst:             1,
		Expiration:        time.Minute,
		CleanupInterval:   time.Minute,
	})
	if status, _ := runProvider(handler); status != http.StatusOK {
		t.Fatalf("first request: status = %d, want 200", status)
	}
	if status, _ := runProvider(handler); status != http.StatusTooManyRequests {
		t.Fatalf("second request: status = %d, want 429 (in-memory bucket)", status)
	}
}
