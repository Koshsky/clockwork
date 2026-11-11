package jwt_test

import (
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/Koshsky/erp-backend/internal/config"
	erpjwt "github.com/Koshsky/erp-backend/internal/security/jwt"
)

const (
	testJWTSecret = "0123456789abcdef0123456789abcdef"
	testIssuer    = "mvs-erp"
	testAccessTTL = 15 * time.Minute
)

// newTestService builds a JWT service with the default test secret and the
// given issuer (kept as a parameter so foreign-issuer cases can be produced).
func newTestService(issuer string) *erpjwt.Service {
	return erpjwt.ProvideJWTService(config.JWTConfig{
		SecretKey:     testJWTSecret,
		AccessExpiry:  config.Duration(testAccessTTL),
		RefreshExpiry: config.Duration(168 * time.Hour),
		Issuer:        issuer,
	})
}

// TestValidateAccessTokenValid checks that a token issued by the same service
// passes validation.
func TestValidateAccessTokenValid(t *testing.T) {
	t.Parallel()

	svc := newTestService(testIssuer)
	token, err := svc.GenerateAccessToken(42, "worker@example.com")
	if err != nil {
		t.Fatalf("GenerateAccessToken() error = %v", err)
	}

	claims, err := svc.ValidateAccessToken(token)
	if err != nil {
		t.Fatalf("ValidateAccessToken() error = %v", err)
	}
	if claims.UserID != 42 {
		t.Errorf("UserID = %d, want 42", claims.UserID)
	}
}

// TestValidateRejectsForeignIssuer checks that a token signed with the same
// secret but a different issuer is rejected.
func TestValidateRejectsForeignIssuer(t *testing.T) {
	t.Parallel()

	foreign := newTestService("other-issuer")
	svc := newTestService(testIssuer)

	token, err := foreign.GenerateAccessToken(1, "worker@example.com")
	if err != nil {
		t.Fatalf("GenerateAccessToken() error = %v", err)
	}

	if _, err = svc.ValidateAccessToken(token); err == nil {
		t.Fatal("ValidateAccessToken() accepted a token with a foreign issuer")
	}
}

// TestValidateRejectsExpired checks that an already-expired access token is
// rejected.
func TestValidateRejectsExpired(t *testing.T) {
	t.Parallel()

	svc := newTestService(testIssuer)
	expired := erpjwt.ProvideJWTService(config.JWTConfig{
		SecretKey:     testJWTSecret,
		AccessExpiry:  config.Duration(-1 * time.Minute),
		RefreshExpiry: config.Duration(168 * time.Hour),
		Issuer:        testIssuer,
	})

	token, err := expired.GenerateAccessToken(1, "worker@example.com")
	if err != nil {
		t.Fatalf("GenerateAccessToken() error = %v", err)
	}

	if _, err = svc.ValidateAccessToken(token); err == nil {
		t.Fatal("ValidateAccessToken() accepted an expired token")
	}
}

// TestValidateRejectsNoneAlg checks that an unsigned (alg=none) token is
// rejected even though it carries valid claims.
func TestValidateRejectsNoneAlg(t *testing.T) {
	t.Parallel()

	svc := newTestService(testIssuer)
	now := time.Now()
	unsigned := jwt.NewWithClaims(jwt.SigningMethodNone, erpjwt.Claims{
		UserID:    1,
		ExpiresAt: jwt.NewNumericDate(now.Add(testAccessTTL)),
		IssuedAt:  jwt.NewNumericDate(now),
		NotBefore: jwt.NewNumericDate(now),
		Issuer:    testIssuer,
	})
	token, err := unsigned.SignedString(jwt.UnsafeAllowNoneSignatureType)
	if err != nil {
		t.Fatalf("SignedString(alg=none) error = %v", err)
	}

	if _, err = svc.ValidateAccessToken(token); err == nil {
		t.Fatal("ValidateAccessToken() accepted an unsigned token")
	}
	if !strings.Contains(err.Error(), "signing method") {
		t.Errorf("error = %v, want a signing-method rejection", err)
	}
}
