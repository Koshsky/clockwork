package jwt

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strconv"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

type Service struct {
	secretKey     []byte
	accessExpiry  time.Duration
	refreshExpiry time.Duration
	issuer        string
}

// GenerateAccessToken generates a new JWT access token for the given user ID.
func (s *Service) GenerateAccessToken(userID int64, email string) (string, error) {
	now := time.Now()
	claims := Claims{
		UserID:    userID,
		Email:     email,
		ExpiresAt: jwt.NewNumericDate(now.Add(s.accessExpiry)),
		IssuedAt:  jwt.NewNumericDate(now),
		NotBefore: jwt.NewNumericDate(now),
		Issuer:    s.issuer,
		Subject:   strconv.FormatInt(userID, 10),
		ID:        randomTokenID(),
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(s.secretKey)
}

// ValidateAccessToken checks and validates the access token: signature, expiry,
// issuer and the signing algorithm (strictly HS256; weaker or none are rejected).
func (s *Service) ValidateAccessToken(tokenString string) (*Claims, error) {
	token, err := jwt.ParseWithClaims(tokenString, &Claims{}, func(token *jwt.Token) (any, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}
		return s.secretKey, nil
	},
		jwt.WithIssuer(s.issuer),
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
	)
	if err != nil {
		return nil, fmt.Errorf("invalid access token: %w", err)
	}

	claims, ok := token.Claims.(*Claims)
	if !ok || !token.Valid {
		return nil, fmt.Errorf("invalid access token claims")
	}

	return claims, nil
}

// RefreshExpiry returns the refresh session lifetime (shared with the cookie Max-Age).
func (s *Service) RefreshExpiry() time.Duration {
	return s.refreshExpiry
}

// AccessExpiry returns the access token lifetime (for the ExpiresIn field).
func (s *Service) AccessExpiry() time.Duration {
	return s.accessExpiry
}

// randomTokenID returns an unpredictable token id (crypto/rand) instead of a
// time-based one that could be guessed (AD-06: was UnixNano of the current time).
func randomTokenID() string {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		// crypto/rand practically never fails; degrading to the current
		// timestamp is acceptable to avoid breaking token signing.
		return strconv.FormatInt(time.Now().UnixNano(), 10)
	}
	return hex.EncodeToString(buf[:])
}
