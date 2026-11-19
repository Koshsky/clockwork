package idempotency_test

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	logpkg "github.com/Koshsky/erp-backend/internal/logger"

	"github.com/gin-gonic/gin"

	"github.com/Koshsky/erp-backend/internal/diagnostics"
	idem "github.com/Koshsky/erp-backend/internal/idempotency"
)

func countOutcome(counts *diagnostics.Outcomes, stage diagnostics.Stage, outcome diagnostics.Outcome) uint64 {
	for _, v := range counts.Snapshot() {
		if v.Stage == stage && v.Outcome == outcome {
			return v.Total
		}
	}
	return 0
}

func TestLegacyOutcomeDistinguishesCommitReplayAndUnconfirmedCommit(t *testing.T) {
	t.Parallel()
	for _, failed := range []bool{false, true} {
		t.Run(map[bool]string{false: "committed", true: "unknown"}[failed], func(t *testing.T) {
			t.Parallel()
			repo := newFakeRepo()
			repo.commitErr = failed
			counts := diagnostics.NewOutcomes()
			mw := idem.New(repo, nil, nil)
			executions := 0
			router := gin.New()
			router.Use(func(c *gin.Context) {
				c.Request = c.Request.WithContext(diagnostics.WithOutcomes(c.Request.Context(), counts))
				c.Next()
			}, setUser(), mw.Handler())
			router.POST(
				"/tasks",
				func(c *gin.Context) { executions++; c.JSON(http.StatusCreated, gin.H{"id": executions}) },
			)
			first := doPost(router, "canary-key")
			if failed {
				if first.Code != 500 || countOutcome(counts, diagnostics.Legacy, diagnostics.Unknown) != 1 ||
					countOutcome(
						counts,
						diagnostics.Legacy,
						diagnostics.Accepted,
					) != 0 || countOutcome(counts, diagnostics.Rollback, diagnostics.RolledBack) != 1 {
					t.Fatal("ambiguous commit became accepted")
				}
				return
			}
			second := doPost(router, "canary-key")
			if first.Code != 201 || second.Code != 201 || executions != 1 ||
				countOutcome(counts, diagnostics.Legacy, diagnostics.Accepted) != 1 ||
				countOutcome(counts, diagnostics.Legacy, diagnostics.Replayed) != 1 {
				t.Fatal("replay became another accepted commit")
			}
		})
	}
}

func TestLegacyRejectedOutcomeKeepsStatusAndRollback(t *testing.T) {
	t.Parallel()
	for _, status := range []int{403, 409, 500} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			t.Parallel()
			repo := newFakeRepo()
			counts := diagnostics.NewOutcomes()
			router := gin.New()
			mw := idem.New(repo, nil, nil)
			router.Use(func(c *gin.Context) {
				c.Request = c.Request.WithContext(diagnostics.WithOutcomes(c.Request.Context(), counts))
				c.Next()
			}, setUser(), mw.Handler())
			router.POST("/tasks", func(c *gin.Context) { c.Status(status) })
			if got := doPost(router, "key"); got.Code != status {
				t.Fatal("diagnostics changed rejected response")
			}
			if countOutcome(counts, diagnostics.Legacy, diagnostics.Accepted) != 0 ||
				countOutcome(counts, diagnostics.Rollback, diagnostics.RolledBack) != 1 {
				t.Fatal("rollback or accepted outcome incorrect")
			}
		})
	}
}

func TestFailedDiagnosticSinkCannotChangeCommittedResponse(t *testing.T) {
	t.Parallel()
	log, err := logpkg.NewWithWriter("debug", "json", failedOutcomeWriter{})
	if err != nil {
		t.Fatal(err)
	}
	repo := newFakeRepo()
	counts := diagnostics.NewOutcomes()
	middleware := idem.New(repo, log, nil)
	executions := 0
	router := buildRouter(middleware, &executions)
	request := httptest.NewRequest(http.MethodPost, "/tasks", nil)
	request.Header.Set(headerKey, "failed-diagnostic-sink")
	request = request.WithContext(diagnostics.WithOutcomes(request.Context(), counts))
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != 201 || executions != 1 || repo.completesCount() != 1 ||
		countOutcome(counts, diagnostics.Legacy, diagnostics.Accepted) != 1 {
		t.Fatal("a failed diagnostic sink changed a committed business outcome")
	}
}

type failedOutcomeWriter struct{}

func (failedOutcomeWriter) Write([]byte) (int, error) { return 0, io.ErrClosedPipe }
