package ratelimit

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"

	"github.com/Koshsky/erp-backend/internal/response"
)

// redisLimiter is a Redis-backed token bucket (M1). Bucket state is kept in a
// single key ("tokens:last_refill") and updated atomically by the Lua script,
// so concurrent requests and multiple application instances race-free share
// one limit per key.
type redisLimiter struct {
	client  *redis.Client
	prefix  string
	keyFunc KeyFunc
	rate    float64
	burst   int
	ttl     time.Duration
	logger  *slog.Logger
}

// rateLimitScript implements the token-bucket algorithm in Lua:
//
//	KEYS[1] — bucket key ("<prefix>:<bucket id>")
//	ARGV[1] — refill rate (tokens per second)
//	ARGV[2] — bucket capacity (burst)
//	ARGV[3] — key TTL (ms)
//
// The current time is read from Redis TIME, so refills stay consistent across
// application instances without client clock skew. Returns {1, 0} when the
// request is allowed, or {0, retry_after_ms} when the bucket is empty. A
// missing key starts with a full bucket.
//
//nolint:gochecknoglobals // redis.NewScript is a shared immutable value (script + SHA cache; same pattern as the wire ProviderSets)
var rateLimitScript = redis.NewScript(`
local rate = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])

local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local v = redis.call('GET', KEYS[1])
local tokens, last
if v then
  local sep = string.find(v, ':')
  tokens = tonumber(string.sub(v, 1, sep - 1))
  last = tonumber(string.sub(v, sep + 1))
else
  tokens = burst
  last = now
end

local elapsed = math.max(0, now - last)
tokens = math.min(burst, tokens + elapsed / 1000 * rate)

if tokens >= 1 then
  tokens = tokens - 1
  redis.call('SET', KEYS[1], tostring(tokens) .. ':' .. tostring(now), 'PX', ttl)
  return {1, 0}
end

local retry = math.ceil((1 - tokens) / rate * 1000)
redis.call('SET', KEYS[1], tostring(tokens) .. ':' .. tostring(last), 'PX', ttl)
return {0, retry}
`)

// handler returns the gin middleware for the bucket.
func (l *redisLimiter) handler() gin.HandlerFunc {
	return func(c *gin.Context) {
		key := l.keyFunc(c)

		allowed, retryMs, err := l.allow(c.Request.Context(), key)
		if err != nil {
			// Runtime fail-open: a transient Redis outage after the successful
			// startup check must never take the API down; the request proceeds
			// unthrottled and the outage is visible in the logs.
			l.logger.ErrorContext(
				c.Request.Context(),
				"redis rate limit check failed (fail-open)",
				"key",
				key,
				"error",
				err,
			)
			c.Next()
			return
		}
		if !allowed {
			c.Header("Retry-After", strconv.Itoa(retryAfterHeaderValue(retryMs)))
			l.logger.WarnContext(c.Request.Context(), "rate limit exceeded", "client_ip", key)
			response.TooManyRequests(c, "too many requests")
			c.Abort()
			return
		}

		c.Next()
	}
}

// allow runs the token-bucket script and reports whether the request may pass
// and how long the client must wait (ms) when it may not.
func (l *redisLimiter) allow(ctx context.Context, key string) (bool, int64, error) {
	res, err := rateLimitScript.Run(ctx, l.client,
		[]string{l.prefix + ":" + key},
		l.rate,
		l.burst,
		int64(l.ttl/time.Millisecond),
	).Result()
	if err != nil {
		return false, 0, err
	}

	arr, ok := res.([]any)
	if !ok || len(arr) != 2 {
		return false, 0, errUnexpectedScriptResult()
	}

	allowed, ok1 := arr[0].(int64)
	retry, ok2 := arr[1].(int64)
	if !ok1 || !ok2 {
		return false, 0, errUnexpectedScriptResult()
	}
	if allowed == 1 {
		return true, 0, nil
	}
	return false, retry, nil
}

// errUnexpectedScriptResult guards against a malformed script response
// (defensive; the script is under our control).
func errUnexpectedScriptResult() error {
	return errors.New("rate limit script returned an unexpected result")
}

// msPerSecond converts retry milliseconds to seconds.
const msPerSecond = 1000

// maxRetryAfterSeconds clamps the Retry-After header (a >1h wait is
// indistinguishable from a ban for the client's purposes and would only
// mislead).
const maxRetryAfterSeconds = 3600

// retryAfterHeaderValue converts the script's retry milliseconds into the
// Retry-After header value (whole seconds, ceil, clamped to [1, 3600]).
func retryAfterHeaderValue(retryMs int64) int {
	secs := int(math.Ceil(float64(max(retryMs, 0)) / msPerSecond))
	return min(max(secs, 1), maxRetryAfterSeconds)
}
