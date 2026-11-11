//go:build integration

// Package repository_test covers the auth refresh-session repository against
// a real Postgres (CI runs it against a migrated database; locally it needs
// DATABASE_URL, e.g. the docker stack's postgres). The single most important
// regression: a revoked session must be findable by hash WITH its revoked_at
// set — the sqlc **time.Time scan bug used to fail on exactly this path and
// silently disabled reuse detection (M4).
package repository_test

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Koshsky/erp-backend/internal/auth/repository"
)

// TestRevokedSessionRoundTrip is the reuse-detection regression test:
// create → find active → revoke → find again must return RevokedAt set.
func TestRevokedSessionRoundTrip(t *testing.T) {
	ctx := context.Background()

	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping integration test")
	}

	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer pool.Close()

	// The schema is seeded (V1000 admin/worker accounts); pick any live user
	// for the session's owner.
	var userID int64
	if err = pool.QueryRow(ctx, "SELECT id FROM users ORDER BY id LIMIT 1").Scan(&userID); err != nil {
		t.Fatalf("no seeded user available: %v", err)
	}

	repo := repository.NewAuthRepository(pool)
	token := testToken()
	hash := hashToken(token)
	ttl := time.Now().Add(time.Hour)

	if _, err = repo.CreateSession(ctx, userID, hash, ttl, pgtype.Int8{}); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, "DELETE FROM refresh_sessions WHERE token_hash = $1", hash)
	})

	// An active session is found with a nil RevokedAt.
	active, err := repo.FindSessionByHash(ctx, hash)
	if err != nil {
		t.Fatalf("FindSessionByHash(active): %v", err)
	}
	if active.RevokedAt.Valid {
		t.Fatalf("active session RevokedAt = %v, want nil", active.RevokedAt)
	}

	// Revoking and re-finding must return the revoked timestamp (this scan
	// used to crash with the sqlc **time.Time bug).
	if err = repo.RevokeSession(ctx, active.ID); err != nil {
		t.Fatalf("RevokeSession: %v", err)
	}
	revoked, err := repo.FindSessionByHash(ctx, hash)
	if err != nil {
		t.Fatalf("FindSessionByHash(revoked): %v", err)
	}
	if !revoked.RevokedAt.Valid {
		t.Fatal("revoked session RevokedAt = nil, want a timestamp (reuse detection would be silently broken)")
	}
}

// TestRevokeAllUserSessions checks the theft-cascade query revokes every
// active session of a user.
func TestRevokeAllUserSessions(t *testing.T) {
	ctx := context.Background()

	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping integration test")
	}

	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer pool.Close()

	var userID int64
	if err = pool.QueryRow(ctx, "SELECT id FROM users ORDER BY id LIMIT 1").Scan(&userID); err != nil {
		t.Fatalf("no seeded user available: %v", err)
	}

	repo := repository.NewAuthRepository(pool)
	var hashes []string
	for range 2 {
		token := testToken()
		h := hashToken(token)
		hashes = append(hashes, h)
		if _, err = repo.CreateSession(ctx, userID, h, time.Now().Add(time.Hour), pgtype.Int8{}); err != nil {
			t.Fatalf("CreateSession: %v", err)
		}
	}
	t.Cleanup(func() {
		for _, h := range hashes {
			_, _ = pool.Exec(ctx, "DELETE FROM refresh_sessions WHERE token_hash = $1", h)
		}
	})

	if err = repo.RevokeAllUserSessions(ctx, userID); err != nil {
		t.Fatalf("RevokeAllUserSessions: %v", err)
	}

	// Both sessions now scan with RevokedAt set.
	for _, h := range hashes {
		sess, err := repo.FindSessionByHash(ctx, h)
		if err != nil {
			t.Fatalf("FindSessionByHash(%s): %v", h, err)
		}
		if !sess.RevokedAt.Valid {
			t.Errorf("session %s not revoked by RevokeAllUserSessions", h)
		}
	}
}

// TestReplacedByChain checks the rotation-chain lookup used by benign-reuse
// detection: the session created with replaced_by set is found when following
// the chain from the rotated-away token, and a dead end errors out.
func TestReplacedByChain(t *testing.T) {
	ctx := context.Background()

	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping integration test")
	}

	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer pool.Close()

	var userID int64
	if err = pool.QueryRow(ctx, "SELECT id FROM users ORDER BY id LIMIT 1").Scan(&userID); err != nil {
		t.Fatalf("no seeded user available: %v", err)
	}

	repo := repository.NewAuthRepository(pool)

	// A fresh login session (no predecessor) starts the family.
	oldHash := hashToken(testToken())
	oldSess, err := repo.CreateSession(ctx, userID, oldHash, time.Now().Add(time.Hour), pgtype.Int8{})
	if err != nil {
		t.Fatalf("CreateSession(old): %v", err)
	}

	// The rotation records the rotated-away session in replaced_by.
	newHash := hashToken(testToken())
	newSess, err := repo.CreateSession(ctx, userID, newHash, time.Now().Add(time.Hour),
		pgtype.Int8{Int64: oldSess.ID, Valid: true})
	if err != nil {
		t.Fatalf("CreateSession(new): %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, "DELETE FROM refresh_sessions WHERE token_hash = ANY($1::text[])", []string{oldHash, newHash})
	})

	found, err := repo.FindSessionByReplacedBy(ctx, oldSess.ID)
	if err != nil {
		t.Fatalf("FindSessionByReplacedBy: %v", err)
	}
	if found.ID != newSess.ID {
		t.Fatalf("chain head = %d, want %d", found.ID, newSess.ID)
	}

	// A token that no session replaced is a dead end (no rows).
	if _, err = repo.FindSessionByReplacedBy(ctx, newSess.ID); err == nil {
		t.Fatal("FindSessionByReplacedBy on the head: want error (dead end), got nil")
	}
}

// testToken returns a unique opaque token (prefix prevents any collision with
// real sessions).
func testToken() string {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return fmt.Sprintf("itest-%d", time.Now().UnixNano())
	}
	return "itest-" + hex.EncodeToString(buf[:])
}

// hashToken mirrors the service's SHA-256 storage hash.
func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}