//nolint:testpackage // white-box: the reuse-detection tests drive the service through in-memory fakes of the unexported SessionRepository seam.
package service

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/Koshsky/erp-backend/internal/auth/repository/sqlc"
	"github.com/Koshsky/erp-backend/internal/config"
	erpjwt "github.com/Koshsky/erp-backend/internal/security/jwt"
	tracingpkg "github.com/Koshsky/erp-backend/internal/tracing"
	userDTO "github.com/Koshsky/erp-backend/internal/user/dto"
)

const (
	testJWTSecret = "0123456789abcdef0123456789abcdef"
	testUserID    = 42
)

// fakeSessionStore implements SessionRepository in memory: sessions keyed by
// token hash with the same replaced_by rotation chain semantics as Postgres.
type fakeSessionStore struct {
	mu              sync.Mutex
	nextID          int64
	byHash          map[string]sqlc.FindSessionByHashRow
	created         []sqlc.CreateSessionRow
	revokedAllCalls int
}

func newFakeSessionStore() *fakeSessionStore {
	return &fakeSessionStore{nextID: 1, byHash: make(map[string]sqlc.FindSessionByHashRow)}
}

// addSession inserts a session for testUserID; revokedAt.Valid=false means the
// session is active.
func (f *fakeSessionStore) addSession(
	hash string,
	revokedAt pgtype.Timestamptz,
	replacedBy int64,
) sqlc.FindSessionByHashRow {
	f.mu.Lock()
	defer f.mu.Unlock()
	row := sqlc.FindSessionByHashRow{
		ID:         f.nextID,
		UserID:     testUserID,
		TokenHash:  hash,
		CreatedAt:  time.Now(),
		ExpiresAt:  time.Now().Add(7 * 24 * time.Hour),
		RevokedAt:  revokedAt,
		ReplacedBy: replacedBy,
	}
	f.nextID++
	f.byHash[hash] = row
	return row
}

func (f *fakeSessionStore) FindSessionByHash(_ context.Context, tokenHash string) (sqlc.FindSessionByHashRow, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	row, ok := f.byHash[tokenHash]
	if !ok {
		return sqlc.FindSessionByHashRow{}, errors.New("session not found")
	}
	return row, nil
}

func (f *fakeSessionStore) FindSessionByReplacedBy(
	_ context.Context,
	id int64,
) (sqlc.FindSessionByReplacedByRow, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var (
		found sqlc.FindSessionByReplacedByRow
		ok    bool
	)
	for _, row := range f.byHash {
		if row.ReplacedBy == id && (!ok || row.ID < found.ID) {
			found = sqlc.FindSessionByReplacedByRow(row)
			ok = true
		}
	}
	if !ok {
		return sqlc.FindSessionByReplacedByRow{}, errors.New("no replacement session")
	}
	return found, nil
}

func (f *fakeSessionStore) CreateSession(
	_ context.Context,
	userID int64,
	tokenHash string,
	expiresAt time.Time,
	replacedBy pgtype.Int8,
) (sqlc.CreateSessionRow, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	row := sqlc.CreateSessionRow{
		ID:         f.nextID,
		UserID:     userID,
		TokenHash:  tokenHash,
		CreatedAt:  time.Now(),
		ExpiresAt:  expiresAt,
		RevokedAt:  pgtype.Timestamptz{},
		ReplacedBy: replacedBy.Int64,
	}
	f.nextID++
	f.byHash[tokenHash] = sqlc.FindSessionByHashRow(row)
	f.created = append(f.created, row)
	return row, nil
}

func (f *fakeSessionStore) RevokeSession(_ context.Context, id int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for hash, row := range f.byHash {
		if row.ID == id {
			row.RevokedAt = pgtype.Timestamptz{Time: time.Now(), Valid: true}
			f.byHash[hash] = row
			break
		}
	}
	return nil
}

func (f *fakeSessionStore) RevokeAllUserSessions(_ context.Context, userID int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.revokedAllCalls++
	for hash, row := range f.byHash {
		if row.UserID == userID {
			row.RevokedAt = pgtype.Timestamptz{Time: time.Now(), Valid: true}
			f.byHash[hash] = row
		}
	}
	return nil
}

func (f *fakeSessionStore) DeleteExpiredSessions(context.Context, time.Time) error { return nil }

// fakeUserService serves a fixed user for both user lookups.
type fakeUserService struct{}

func (fakeUserService) FindUserByUsername(context.Context, string) (*userDTO.UserResponse, error) {
	return testUser(), nil
}

func (fakeUserService) FindUserByID(context.Context, int64) (*userDTO.UserResponse, error) {
	return testUser(), nil
}

func testUser() *userDTO.UserResponse {
	preset := "worker"
	return &userDTO.UserResponse{ID: testUserID, Username: "worker", Preset: &preset}
}

// newTestAuthService wires the service with an in-memory session store, a fake
// user source and a real JWT service (only its expiry durations matter here).
func newTestAuthService(store *fakeSessionStore) *AuthService {
	return &AuthService{
		logger: slog.New(slog.DiscardHandler),
		users:  fakeUserService{},
		jwt: erpjwt.ProvideJWTService(config.JWTConfig{
			SecretKey:     testJWTSecret,
			AccessExpiry:  config.Duration(15 * time.Minute),
			RefreshExpiry: config.Duration(168 * time.Hour),
			Issuer:        "mvs-erp-test",
		}),
		sessions: store,
		tracer:   tracingpkg.New(nil),
	}
}

// TestRefreshTokenBenignReuseWithinGrace — a client retry presenting the
// rotated-away token right after its own successful refresh is a benign
// concurrent duplicate: no family revocation, a fresh pair is re-issued and
// chained to the presented token.
func TestRefreshTokenBenignReuseWithinGrace(t *testing.T) {
	t.Parallel()

	store := newFakeSessionStore()
	now := time.Now()
	old := store.addSession(hashToken("benign-old"),
		pgtype.Timestamptz{Time: now.Add(-2 * time.Second), Valid: true}, 0)
	store.addSession(hashToken("benign-new"), pgtype.Timestamptz{}, old.ID)
	svc := newTestAuthService(store)

	result, err := svc.RefreshToken(context.Background(), "benign-old")
	if err != nil {
		t.Fatalf("RefreshToken(benign reuse) error = %v, want a fresh pair", err)
	}
	if result.RefreshToken == "" {
		t.Fatal("RefreshToken(benign reuse) returned an empty refresh token")
	}
	if store.revokedAllCalls != 0 {
		t.Fatalf("benign reuse revoked the whole family (%d RevokeAllUserSessions calls)", store.revokedAllCalls)
	}
	if len(store.created) == 0 || store.created[len(store.created)-1].ReplacedBy != old.ID {
		t.Fatalf("re-issued session not chained to the presented token: %+v", store.created)
	}
}

// TestRefreshTokenReuseOlderThanGraceRevokesFamily — a token rotated away
// longer ago than the grace window is a replay of a dead credential: the whole
// session family is revoked and no new pair is issued.
func TestRefreshTokenReuseOlderThanGraceRevokesFamily(t *testing.T) {
	t.Parallel()

	store := newFakeSessionStore()
	now := time.Now()
	old := store.addSession(hashToken("stale-old"),
		pgtype.Timestamptz{Time: now.Add(-2 * time.Hour), Valid: true}, 0)
	store.addSession(hashToken("stale-new"), pgtype.Timestamptz{}, old.ID)
	svc := newTestAuthService(store)

	if _, err := svc.RefreshToken(context.Background(), "stale-old"); err == nil {
		t.Fatal("RefreshToken(old replay) error = nil, want invalid refresh token")
	}
	if store.revokedAllCalls != 1 {
		t.Fatalf("old replay: RevokeAllUserSessions calls = %d, want 1 (family revoked)", store.revokedAllCalls)
	}
}

// TestRefreshTokenReuseWithoutLiveChainRevokesFamily — a revoked token whose
// chain does not resolve to a live session (e.g. revoked by logout, not by
// rotation) is treated as theft even inside the grace window.
func TestRefreshTokenReuseWithoutLiveChainRevokesFamily(t *testing.T) {
	t.Parallel()

	store := newFakeSessionStore()
	store.addSession(hashToken("dead-old"),
		pgtype.Timestamptz{Time: time.Now().Add(-2 * time.Second), Valid: true}, 0)
	svc := newTestAuthService(store)

	if _, err := svc.RefreshToken(context.Background(), "dead-old"); err == nil {
		t.Fatal("RefreshToken(chainless replay) error = nil, want invalid refresh token")
	}
	if store.revokedAllCalls != 1 {
		t.Fatalf("chainless replay: RevokeAllUserSessions calls = %d, want 1", store.revokedAllCalls)
	}
}

// TestRefreshTokenRotationChainsNewSession — a regular rotation revokes the old
// session and chains the new one to it via replaced_by; the family is not
// revoked.
func TestRefreshTokenRotationChainsNewSession(t *testing.T) {
	t.Parallel()

	store := newFakeSessionStore()
	cur := store.addSession(hashToken("cur"), pgtype.Timestamptz{}, 0)
	svc := newTestAuthService(store)

	result, err := svc.RefreshToken(context.Background(), "cur")
	if err != nil {
		t.Fatalf("RefreshToken(active) error = %v", err)
	}
	if result.RefreshToken == "" {
		t.Fatal("RefreshToken(active) returned an empty refresh token")
	}
	if store.revokedAllCalls != 0 {
		t.Fatalf("normal rotation revoked the family (%d calls)", store.revokedAllCalls)
	}
	rotated, _ := store.FindSessionByHash(context.Background(), hashToken("cur"))
	if !rotated.RevokedAt.Valid {
		t.Fatal("rotated-away session is not marked revoked")
	}
	if len(store.created) == 0 || store.created[len(store.created)-1].ReplacedBy != cur.ID {
		t.Fatalf("new session not chained to the rotated-away token: %+v", store.created)
	}
}
