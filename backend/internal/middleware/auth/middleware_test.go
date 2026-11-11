package auth_test

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/Koshsky/erp-backend/internal/config"
	authmw "github.com/Koshsky/erp-backend/internal/middleware/auth"
	erpjwt "github.com/Koshsky/erp-backend/internal/security/jwt"
	userctx "github.com/Koshsky/erp-backend/internal/userctx"
)

const (
	testSecret = "0123456789abcdef0123456789abcdef"
	testIssuer = "mvs-erp"
)

// stubResolver fakes the RBAC PolicyStore snapshot (PrincipalResolver): it
// returns a fixed principal or an error and records the user id it was asked
// to resolve.
type stubResolver struct {
	user   userctx.UserContext
	err    error
	lastID int64
}

func (s *stubResolver) EffectiveUser(_ context.Context, userID int64) (userctx.UserContext, error) {
	s.lastID = userID
	if s.err != nil {
		return userctx.UserContext{}, s.err
	}
	return s.user, nil
}

// newJWT builds a JWT service for the given signing parameters; the expiry is
// negative to mint already-expired tokens.
func newJWT(secret, issuer string, accessTTL time.Duration) *erpjwt.Service {
	return erpjwt.ProvideJWTService(config.JWTConfig{
		SecretKey:     secret,
		AccessExpiry:  config.Duration(accessTTL),
		RefreshExpiry: config.Duration(168 * time.Hour),
		Issuer:        issuer,
	})
}

// bearerToken mints a Bearer access token with the given service.
func bearerToken(t *testing.T, svc *erpjwt.Service, userID int64, email string) string {
	t.Helper()
	token, err := svc.GenerateAccessToken(userID, email)
	if err != nil {
		t.Fatalf("GenerateAccessToken() error = %v", err)
	}
	return "Bearer " + token
}

// probeResult captures the middleware outcome for one request: the status, the
// error code from the {data, error} envelope ("" on 200), whether the real
// handler ran, and the user context stored by the middleware (on 200).
type probeResult struct {
	status int
	code   string
	ran    bool
	user   userctx.UserContext
}

// runProbe serves a single request through the middleware; token == "" sends
// no Authorization header at all.
func runProbe(mw gin.HandlerFunc, token string) probeResult {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	ran := false
	r.Use(mw)
	r.GET("/probe", func(c *gin.Context) {
		ran = true
		u, err := userctx.GetUser(c) // read via the public accessor on KeyUser
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"err": err.Error()})
			return
		}
		c.JSON(http.StatusOK, u)
	})

	req := httptest.NewRequest(http.MethodGet, "/probe", nil)
	if token != "" {
		req.Header.Set("Authorization", token)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	res := probeResult{status: w.Code, ran: ran}
	if w.Code == http.StatusOK {
		// The probe handler echoes the raw UserContext, not the envelope.
		_ = json.Unmarshal(w.Body.Bytes(), &res.user)
	} else {
		var body struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		_ = json.Unmarshal(w.Body.Bytes(), &body)
		res.code = body.Error.Code
	}
	return res
}

// defaultMW shares the standard middleware (same secret + issuer for minting
// and validating).
func defaultMW() (*authmw.Middleware, *erpjwt.Service, *stubResolver) {
	svc := newJWT(testSecret, testIssuer, 15*time.Minute)
	stub := &stubResolver{user: userctx.UserContext{ID: 42, Admin: true, Preset: "admin"}}
	mw := authmw.ProvideAuthMiddleware(slog.New(slog.DiscardHandler), svc, stub)
	return mw, svc, stub
}

// TestRequireAuthRejectsInvalidRequests checks every 401 path: a missing
// header, a non-Bearer scheme, an empty token, garbage, an expired token, a
// foreign issuer and a foreign signature must all be rejected with 401 and the
// proper error code, without ever touching the downstream handler.
func TestRequireAuthRejectsInvalidRequests(t *testing.T) {
	t.Parallel()

	expired := newJWT(testSecret, testIssuer, -1*time.Minute)
	foreignIssuer := newJWT(testSecret, "other-issuer", 15*time.Minute)
	foreignSecret := newJWT("fedcba9876543210fedcba9876543210", testIssuer, 15*time.Minute)

	cases := []struct {
		name      string
		token     string
		wantCode  string
		wantError string
	}{
		{"missing header", "", "UNAUTHORIZED", "authorization header required"},
		{"non-bearer scheme", "Basic dXNlcjpwYXNz", "INVALID_TOKEN", "invalid authorization format"},
		{"empty token", "Bearer ", "INVALID_TOKEN", "token is empty"},
		{"garbage token", "Bearer not-a-jwt", "INVALID_TOKEN", "invalid or expired token"},
		{"expired token", bearerToken(t, expired, 42, "boss@example.com"), "INVALID_TOKEN", "invalid or expired token"},
		{
			"foreign issuer",
			bearerToken(t, foreignIssuer, 42, "boss@example.com"),
			"INVALID_TOKEN",
			"invalid or expired token",
		},
		{
			"foreign signature",
			bearerToken(t, foreignSecret, 42, "boss@example.com"),
			"INVALID_TOKEN",
			"invalid or expired token",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			mw, _, _ := defaultMW()
			res := runProbe(mw.RequireAuth(), tc.token)

			if res.status != http.StatusUnauthorized {
				t.Errorf("status = %d, want 401", res.status)
			}
			if res.code != tc.wantCode {
				t.Errorf("error code = %q, want %q", res.code, tc.wantCode)
			}
			if res.ran {
				t.Error("handler ran, want it not to run on a rejected request")
			}
		})
	}
}

// TestRequireAuthValidTokenPopulatesUser checks the happy path: a valid token
// resolves the principal, the middleware stores the user under KeyUser with
// ID/Email from the claims and Admin/Preset from the resolver, and the
// downstream handler runs.
func TestRequireAuthValidTokenPopulatesUser(t *testing.T) {
	t.Parallel()

	mw, svc, stub := defaultMW()
	stub.user = userctx.UserContext{ID: 42, Admin: true, Preset: "admin"}

	res := runProbe(mw.RequireAuth(), bearerToken(t, svc, 42, "boss@example.com"))

	if res.status != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.status)
	}
	if !res.ran {
		t.Fatal("handler did not run, want it to run for a valid token")
	}
	if res.user.ID != 42 {
		t.Errorf("user.ID = %d, want 42", res.user.ID)
	}
	if res.user.Email != "boss@example.com" {
		t.Errorf("user.Email = %q, want %q", res.user.Email, "boss@example.com")
	}
	if !res.user.Admin {
		t.Errorf("user.Admin = false, want true (admin flag from the resolver)")
	}
	if res.user.Preset != "admin" {
		t.Errorf("user.Preset = %q, want %q", res.user.Preset, "admin")
	}
	if stub.lastID != 42 {
		t.Errorf("resolver asked for user id %d, want 42", stub.lastID)
	}
}

// TestRequireAuthAdminFlagChecks preserves the admin bypass contract: the
// resolver's Admin flag flows into the context and is visible through the
// userctx helpers on the actual API.
func TestRequireAuthAdminFlagChecks(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name   string
		admin  bool
		preset string
	}{
		{"admin resolver → IsAdmin() true", true, "admin"},
		{"plain resolver → IsAdmin() false", false, "rp"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			mw, svc, stub := defaultMW()
			stub.user = userctx.UserContext{ID: 7, Admin: tc.admin, Preset: tc.preset}

			gin.SetMode(gin.TestMode)
			r := gin.New()
			r.Use(mw.RequireAuth())
			r.GET("/probe", func(c *gin.Context) {
				if got := userctx.IsAdmin(c); got != tc.admin {
					t.Errorf("userctx.IsAdmin(c) = %v, want %v", got, tc.admin)
				}
				c.Status(http.StatusOK)
			})

			w := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, "/probe", nil)
			req.Header.Set("Authorization", bearerToken(t, svc, 7, "worker@example.com"))
			r.ServeHTTP(w, req)

			if w.Code != http.StatusOK {
				t.Errorf("status = %d, want 200", w.Code)
			}
		})
	}
}

// TestRequireAuthResolverErrorFallsBack checks the resolver failure path: the
// middleware must not fail the request — it stores a default (deny) principal
// carrying the claims identity so the handler still runs.
func TestRequireAuthResolverErrorFallsBack(t *testing.T) {
	t.Parallel()

	mw, svc, stub := defaultMW()
	stub.err = errors.New("snapshot load failed")

	res := runProbe(mw.RequireAuth(), bearerToken(t, svc, 42, "boss@example.com"))

	if res.status != http.StatusOK {
		t.Fatalf("status = %d, want 200 (resolver failure must not reject the request)", res.status)
	}
	if !res.ran {
		t.Fatal("handler did not run, want it to run with the fallback principal")
	}
	if res.user.ID != 42 {
		t.Errorf("user.ID = %d, want 42 (claims identity survived)", res.user.ID)
	}
	if res.user.Email != "boss@example.com" {
		t.Errorf("user.Email = %q, want %q", res.user.Email, "boss@example.com")
	}
	if res.user.Admin {
		t.Errorf("user.Admin = true, want false (deny-by-default on resolver failure)")
	}
}
