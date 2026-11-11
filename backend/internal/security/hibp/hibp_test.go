package hibp_test

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Koshsky/erp-backend/internal/security/hibp"
)

// sha1HexUpper returns the uppercase SHA-1 hex of the password (mirrors the
// Checker's digest computation).
func sha1HexUpper(password string) string {
	sum := sha1.Sum([]byte(password))
	return strings.ToUpper(hex.EncodeToString(sum[:]))
}

func TestCheckFound(t *testing.T) {
	t.Parallel()

	const password = "velociraptor1"
	digest := sha1HexUpper(password)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		prefix := strings.TrimPrefix(r.URL.Path, "/range/")
		if len(prefix) != 5 {
			t.Errorf("ожидался 5-символьный префикс, получили %q", prefix)
		}
		_, _ = w.Write([]byte("0000000000000000000000000000000000000000:1\n" + digest[5:] + ":364021\n"))
	}))
	defer server.Close()

	checker := hibp.NewCheckerForEndpoint(true, 2*time.Second, server.URL+"/range/")

	found, err := checker.Check(context.Background(), password)
	if err != nil {
		t.Fatalf("Check вернул ошибку: %v", err)
	}
	if !found {
		t.Fatal("пароль должен быть найден в ответе фида")
	}
}

func TestCheckNotFound(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("0000000000000000000000000000000000000000:1\n"))
	}))
	defer server.Close()

	checker := hibp.NewCheckerForEndpoint(true, 2*time.Second, server.URL+"/range/")

	found, err := checker.Check(context.Background(), "totally-unique-1")
	if err != nil {
		t.Fatalf("Check вернул ошибку: %v", err)
	}
	if found {
		t.Fatal("пароль не должен быть найден")
	}
}

func TestCheckDisabledSkipsNetwork(t *testing.T) {
	t.Parallel()

	checker := hibp.NewChecker(false, time.Second)
	found, err := checker.Check(context.Background(), "whatever1")
	if err != nil {
		t.Fatalf("выключенный чекер не должен давать ошибок: %v", err)
	}
	if found {
		t.Fatal("выключенный чекер не должен находить пароль")
	}
}

func TestCheckNetworkErrorSkips(t *testing.T) {
	t.Parallel()

	// Unreachable endpoint: best-effort — the check fails with an error and
	// the caller skips it (not-found + error); the local policy still gates.
	checker := hibp.NewCheckerForEndpoint(true, 100*time.Millisecond, "http://127.0.0.1:1/range/")

	found, err := checker.Check(context.Background(), "anything1")
	if found {
		t.Fatal("при недоступном фиде пароль не должен находиться")
	}
	if err == nil {
		t.Fatal("недоступный фид должен давать ошибку (caller пропускает проверку)")
	}
}
