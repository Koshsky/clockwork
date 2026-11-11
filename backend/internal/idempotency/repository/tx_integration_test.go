//go:build integration

// Package repository_test covers the transactional idempotency flow against a
// real Postgres (CI runs it against a migrated database; locally it needs
// DATABASE_URL, e.g. the docker stack's postgres).
//
// The regressions guarded here are the crash windows the request-scoped
// transaction closes:
//
//  1. a rolled-back request leaves NO business row and the key stays
//     in-flight/reclaimable — the retry re-executes instead of duplicating;
//  2. commit persists the business row and the completed key atomically — a
//     retry replays the saved response;
//  3. a released key lets the next request claim and execute fresh.
package repository_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Koshsky/erp-backend/internal/database"
	"github.com/Koshsky/erp-backend/internal/idempotency/repository"
)

// codePrefix marks states rows created by these tests; keyPrefix marks the
// idempotency keys, so cleanup stays scoped to the tests.
const (
	codePrefix = "tx-integration-"
	keyPrefix  = "txk-"
	// testUser is the user id the claims are bound to.
	testUser = int64(42)
	// testMethod/testPath — the route scope of the claims.
	testMethod = "POST"
	testPath   = "/tasks"
	// testKeyTTL mirrors the middleware's keyTTL.
	testKeyTTL = 24 * time.Hour
)

// newTestRepo connects to DATABASE_URL (skipping otherwise) and returns the
// repository plus the pool used for direct assertions/cleanup.
func newTestRepo(t *testing.T) (*repository.IdempotencyRepository, *pgxpool.Pool) {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping integration test")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	repo := repository.NewIdempotencyRepository(pool)
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, "DELETE FROM states WHERE code LIKE $1", codePrefix+"%")
		_, _ = pool.Exec(ctx, "DELETE FROM idempotency_keys WHERE key LIKE $1", keyPrefix+"%")
	})
	return repo, pool
}

// uniqueCode returns a collision-free states code for one test run.
func uniqueCode(t *testing.T) string {
	t.Helper()
	return codePrefix + t.Name() + "-" + fmt.Sprintf("%d", time.Now().UnixNano())
}

// insertBusinessState inserts a states row on the given transaction — the
// "business write" of an idempotent create.
func insertBusinessState(ctx context.Context, tx pgx.Tx, code, name string) error {
	_, err := tx.Exec(ctx, "INSERT INTO states (code, name) VALUES ($1, $2)", code, name)
	return err
}

// stateExists reports whether a states row with the code exists.
func stateExists(ctx context.Context, pool *pgxpool.Pool, code string) (bool, error) {
	var one int
	err := pool.QueryRow(ctx, "SELECT 1 FROM states WHERE code = $1", code).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// TestClaimThenRollbackLeavesNoBusinessRow — the crash window: a request dies
// after writing its business row but before completing the key. The rollback
// must remove the business row, and the committed claim row must stay
// in-flight (reclaimable after the lease) so a retry re-executes instead of
// replaying or duplicating.
func TestClaimThenRollbackLeavesNoBusinessRow(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	code := uniqueCode(t)
	key := keyPrefix + "rollback"

	_, claimed, tx, err := repo.Claim(ctx, key, testUser, testMethod, testPath, time.Now().Add(testKeyTTL))
	if err != nil {
		t.Fatalf("first claim: %v", err)
	}
	if !claimed {
		t.Fatal("first claim must win")
	}
	if err = insertBusinessState(ctx, tx, code, "rollback"); err != nil {
		t.Fatalf("business insert: %v", err)
	}
	// The request "crashes": rollback without Complete.
	if err = tx.Rollback(ctx); err != nil {
		t.Fatalf("rollback: %v", err)
	}

	if exists, err := stateExists(ctx, pool, code); err != nil {
		t.Fatalf("state check: %v", err)
	} else if exists {
		t.Fatal("business row must be rolled back together with the request")
	}

	// The claim row is still there (status=0): an immediate retry gets
	// in-flight, not a fresh claim.
	_, claimedAgain, tx2, err := repo.Claim(ctx, key, testUser, testMethod, testPath, time.Now().Add(testKeyTTL))
	if err != nil {
		t.Fatalf("second claim: %v", err)
	}
	if claimedAgain {
		t.Fatal("a fresh claim must not win while the previous one is still in-flight")
	}
	_ = tx2

	// Simulate the lease expiring (the claiming request crashed): the claim
	// becomes reclaimable and a retry re-claims and re-executes.
	if _, err = pool.Exec(ctx, "UPDATE idempotency_keys SET created_at = NOW() - INTERVAL '4 minutes' WHERE key = $1 AND user_id = $2", key, testUser); err != nil {
		t.Fatalf("age claim: %v", err)
	}
	_, reclaimed, tx3, err := repo.Claim(ctx, key, testUser, testMethod, testPath, time.Now().Add(testKeyTTL))
	if err != nil {
		t.Fatalf("reclaim after lease: %v", err)
	}
	if !reclaimed {
		t.Fatal("an in-flight claim older than the lease must be re-claimed")
	}
	// Re-execute cleanly and complete: business row + key commit atomically.
	if err = insertBusinessState(ctx, tx3, code, "rollback-reexecuted"); err != nil {
		t.Fatalf("business insert on retry: %v", err)
	}
	txCtx := database.WithTx(ctx, tx3)
	if err = repo.Complete(txCtx, key, testUser, testMethod, testPath, 200, json.RawMessage(`{"ok":true}`)); err != nil {
		t.Fatalf("complete: %v", err)
	}
	if err = tx3.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	if exists, err := stateExists(ctx, pool, code); err != nil {
		t.Fatalf("state check after retry: %v", err)
	} else if !exists {
		t.Fatal("the retried create must persist its business row")
	}
}

// TestCompleteCommitsAtomicallyWithBusiness — the happy path: the completed
// key and the business row become visible to other connections only after the
// commit, and a retry then replays the saved response instead of re-executing.
func TestCompleteCommitsAtomicallyWithBusiness(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	code := uniqueCode(t)
	key := keyPrefix + "atomic"

	_, claimed, tx, err := repo.Claim(ctx, key, testUser, testMethod, testPath, time.Now().Add(testKeyTTL))
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if !claimed {
		t.Fatal("claim must win")
	}
	if err = insertBusinessState(ctx, tx, code, "atomic"); err != nil {
		t.Fatalf("business insert: %v", err)
	}
	// The business row must NOT be visible before the commit.
	if exists, err := stateExists(ctx, pool, code); err != nil {
		t.Fatalf("pre-commit state check: %v", err)
	} else if exists {
		t.Fatal("business row must stay invisible until the transaction commits")
	}

	txCtx := database.WithTx(ctx, tx)
	if err = repo.Complete(txCtx, key, testUser, testMethod, testPath, 201, json.RawMessage(`{"id":7}`)); err != nil {
		t.Fatalf("complete: %v", err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}

	if exists, err := stateExists(ctx, pool, code); err != nil {
		t.Fatalf("post-commit state check: %v", err)
	} else if !exists {
		t.Fatal("business row must be visible after commit")
	}

	// A retry with the same key replays the saved response.
	result, replayed, _, err := repo.Claim(ctx, key, testUser, testMethod, testPath, time.Now().Add(testKeyTTL))
	if err != nil {
		t.Fatalf("replay claim: %v", err)
	}
	if replayed {
		t.Fatal("a completed key must not be re-claimed")
	}
	if result == nil {
		t.Fatal("the completed key must return the saved response")
	}
	// The body round-trips through the jsonb column, so compare JSON semantics
	// (whitespace/key ordering are normalized by the server), not raw bytes.
	var want, got map[string]any
	if err := json.Unmarshal([]byte(`{"id":7}`), &want); err != nil {
		t.Fatalf("unmarshal want: %v", err)
	}
	if err := json.Unmarshal(result.Body, &got); err != nil {
		t.Fatalf("unmarshal replay body %q: %v", result.Body, err)
	}
	if result.Status != 201 || !reflect.DeepEqual(got, want) {
		t.Fatalf("replay = %d %s, want 201 {\"id\":7}", result.Status, result.Body)
	}
}

// TestNon2xxRollsBackAndReleases — a failed request (4xx/5xx) rolls back its
// writes and releases the key, so the next retry claims fresh and re-executes.
func TestNon2xxRollsBackAndReleases(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	code := uniqueCode(t)
	key := keyPrefix + "non2xx"

	_, claimed, tx, err := repo.Claim(ctx, key, testUser, testMethod, testPath, time.Now().Add(testKeyTTL))
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if !claimed {
		t.Fatal("claim must win")
	}
	if err = insertBusinessState(ctx, tx, code, "non2xx"); err != nil {
		t.Fatalf("business insert: %v", err)
	}
	if err = tx.Rollback(ctx); err != nil {
		t.Fatalf("rollback: %v", err)
	}
	if err = repo.Release(ctx, key, testUser, testMethod, testPath); err != nil {
		t.Fatalf("release: %v", err)
	}

	if exists, err := stateExists(ctx, pool, code); err != nil {
		t.Fatalf("state check: %v", err)
	} else if exists {
		t.Fatal("business row must be rolled back on a failed request")
	}

	// The key is gone: the next retry claims fresh immediately.
	_, reclaimed, tx2, err := repo.Claim(ctx, key, testUser, testMethod, testPath, time.Now().Add(testKeyTTL))
	if err != nil {
		t.Fatalf("re-claim after release: %v", err)
	}
	if !reclaimed {
		t.Fatal("a released key must be claimable by the next retry")
	}
	if err = tx2.Rollback(ctx); err != nil {
		t.Fatalf("cleanup rollback: %v", err)
	}
}

// TestConcurrentClaimsSingleWinner — two concurrent requests with the same key
// must produce exactly one claim; the loser observes the winner as in-flight.
func TestConcurrentClaimsSingleWinner(t *testing.T) {
	repo, _ := newTestRepo(t)
	ctx := context.Background()
	key := keyPrefix + "concurrent"

	const workers = 2
	var (
		mu      sync.Mutex
		claimed int
		defined int // claim=false with a result (replay) — impossible here, both are racing the first insert
		inflight int
	)
	var wg sync.WaitGroup
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			result, ok, tx, err := repo.Claim(ctx, key, testUser, testMethod, testPath, time.Now().Add(testKeyTTL))
			if err != nil {
				t.Errorf("claim: %v", err)
				return
			}
			mu.Lock()
			defer mu.Unlock()
			if ok {
				claimed++
				_ = tx.Rollback(context.Background())
				return
			}
			if result != nil {
				defined++
				return
			}
			inflight++
		}()
	}
	wg.Wait()

	if claimed != 1 {
		t.Fatalf("claimed = %d, want exactly 1 (single winner)", claimed)
	}
	if inflight != 1 {
		t.Fatalf("inflight = %d, want 1 (the loser must see the winner in-flight)", inflight)
	}
	if defined != 0 {
		t.Fatalf("replay results = %d, want 0 (nothing completed yet)", defined)
	}
}