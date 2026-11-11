// Package hibp checks passwords against the Have I Been Pwned breach database
// with the k-anonymity range API: only the first five hex characters of the
// SHA-1 digest leave the server; the rest is matched locally against the
// returned suffix list. Best-effort by design: network failures or timeouts
// skip the check instead of blocking a password change.
package hibp

import (
	"bufio"
	"context"
	"crypto/sha1" //nolint:gosec // HIBP's k-anonymity API is built on SHA-1; required by the protocol.
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/Koshsky/erp-backend/internal/config"
)

// defaultRangeEndpoint is the public k-anonymity endpoint (fixed, no auth).
const defaultRangeEndpoint = "https://api.pwnedpasswords.com/range/"

// maxResponseBytes caps the range response body (the suffix list for one
// prefix is a few hundred KB at most).
const maxResponseBytes = 1 << 20

// Checker verifies passwords against the HIBP breach feed.
type Checker struct {
	client  *http.Client
	enabled bool
	baseURL string
}

// NewChecker builds a HIBP checker. A disabled checker reports nothing.
func NewChecker(enable bool, timeout time.Duration) *Checker {
	return &Checker{
		enabled: enable,
		client:  &http.Client{Timeout: timeout},
		baseURL: defaultRangeEndpoint,
	}
}

// NewCheckerForEndpoint builds a checker pointed at a custom k-anonymity
// endpoint (tests and self-hosted mirrors of the feed).
func NewCheckerForEndpoint(enable bool, timeout time.Duration, baseURL string) *Checker {
	c := NewChecker(enable, timeout)
	c.baseURL = baseURL
	return c
}

// ProvideChecker builds the HIBP checker from the application security config.
func ProvideChecker(cfg config.SecurityConfig) *Checker {
	return NewChecker(cfg.Password.HIBP.Enabled, time.Duration(cfg.Password.HIBP.Timeout))
}

// Check reports whether the password appears in known breaches. When the
// check is disabled it returns (false, nil). A feed failure (network,
// timeout, non-200, malformed body) returns (false, error) — callers treat
// any error as "skip": the local password policy remains the hard gate.
func (c *Checker) Check(ctx context.Context, password string) (bool, error) {
	if c == nil || !c.enabled {
		return false, nil
	}

	sum := sha1.Sum([]byte(password)) //nolint:gosec // HIBP protocol is SHA-1-based.
	digest := strings.ToUpper(hex.EncodeToString(sum[:]))
	prefix, suffix := digest[:5], digest[5:]

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+prefix, nil)
	if err != nil {
		return false, fmt.Errorf("hibp: build request: %w", err)
	}

	resp, err := c.client.Do(req)
	if err != nil {
		return false, fmt.Errorf("hibp: request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return false, fmt.Errorf("hibp: unexpected status %d", resp.StatusCode)
	}

	scanner := bufio.NewScanner(io.LimitReader(resp.Body, maxResponseBytes))
	for scanner.Scan() {
		line := scanner.Text()
		// Each line: SUFFIX:COUNT (suffix is uppercase hex without the prefix).
		hit, _, ok := strings.Cut(line, ":")
		if ok && hit == suffix {
			return true, nil
		}
	}
	if scanErr := scanner.Err(); scanErr != nil {
		return false, fmt.Errorf("hibp: read response: %w", scanErr)
	}
	return false, nil
}
