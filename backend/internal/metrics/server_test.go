package metrics_test

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Koshsky/erp-backend/internal/config"
	errinternal "github.com/Koshsky/erp-backend/internal/errors"
	"github.com/Koshsky/erp-backend/internal/metrics"
)

func TestMetricsRejectsNonPrivateOrAmbiguousAddresses(t *testing.T) {
	t.Parallel()
	for _, address := range []string{"", ":9091", "0.0.0.0:9091", "[::]:9091", "localhost:9091", "example.com:9091", "8.8.8.8:9091", "127.0.0.1:65536", "127.0.0.1:canary-token", "http://127.0.0.1:9091"} {
		t.Run(address, func(t *testing.T) {
			t.Parallel()
			_, err := metrics.New(config.MetricsConfig{Enabled: true, Address: address}, nil)
			if !errors.Is(err, errinternal.ErrConfiguration) ||
				strings.Contains(err.Error(), address) && address != "" {
				t.Fatalf("invalid address accepted or echoed: %v", err)
			}
		})
	}
	for _, address := range []string{"127.0.0.1:9091", "[::1]:9091", "10.0.0.4:9091", "172.18.0.4:9091", "192.168.1.4:9091", "[fd00::1]:9091"} {
		t.Run(address, func(t *testing.T) {
			t.Parallel()
			if _, err := metrics.New(config.MetricsConfig{Enabled: true, Address: address}, nil); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestPrivateEndpointIgnoresSessionsAndForwardingHeaders(t *testing.T) {
	t.Parallel()
	m := enabledMetrics(t)
	for _, tc := range []struct {
		name, remote, method, path string
		want                       int
	}{
		{"local scrape", "127.0.0.1:1234", "GET", "/metrics", 200},
		{"private scraper", "10.0.0.4:1234", "GET", "/metrics", 200},
		{"external scraper", "203.0.113.4:1234", "GET", "/metrics", 403},
		{"missing peer", "", "GET", "/metrics", 403},
		{"other path", "127.0.0.1:1234", "GET", "/private", 404},
		{"unsupported method", "127.0.0.1:1234", "POST", "/metrics", 405},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			r := httptest.NewRequest(tc.method, tc.path, nil)
			r.RemoteAddr = tc.remote
			r.Header.Set("Authorization", "canary-user-session")
			r.Header.Set("Cookie", "canary-cookie")
			r.Header.Set("X-Forwarded-For", "127.0.0.1")
			w := httptest.NewRecorder()
			m.Handler().ServeHTTP(w, r)
			if w.Code != tc.want || strings.Contains(w.Body.String(), "canary") {
				t.Fatalf("private boundary failed: %d", w.Code)
			}
		})
	}
}

func TestDisabledMetricsDoesNotCreateListenerOrAffectOperations(t *testing.T) {
	t.Parallel()
	m, err := metrics.New(config.MetricsConfig{Address: "canary-invalid"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	m.SetRoutes([]string{"/tasks/:id"})
	record(m, "/tasks/:id", "PATCH", 200)
	m.PoolAcquire(t.Context(), errors.New("canary-error"))
	m.AttachPool(nil)
	if err = m.Start(); err != nil {
		t.Fatal(err)
	}
	if m.Enabled() || m.Address() != "" || m.Begin("/tasks/:id") {
		t.Fatal("disabled metrics created instrumentation/listener")
	}
	response := httptest.NewRecorder()
	m.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if response.Code != 404 {
		t.Fatal("disabled metrics exposed a registry")
	}
	if err = m.Stop(t.Context()); err != nil {
		t.Fatal(err)
	}
}

func TestListenerServesWithoutSessionAndStopsIdempotently(t *testing.T) {
	t.Parallel()
	m := enabledMetrics(t)
	if err := m.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = m.Stop(context.Background()) })
	original := m.Address()
	if err := m.Start(); err != nil || m.Address() != original {
		t.Fatal("start created a second listener")
	}
	client := &http.Client{Timeout: time.Second}
	response, err := client.Get("http://" + original + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || !strings.Contains(string(body), "go_goroutines") {
		t.Fatal("standalone metrics unavailable")
	}
	if err = m.Stop(t.Context()); err != nil {
		t.Fatal(err)
	}
	if err = m.Stop(t.Context()); err != nil {
		t.Fatal(err)
	}
	dialer := net.Dialer{Timeout: time.Second}
	conn, err := dialer.DialContext(t.Context(), "tcp", original)
	if err == nil {
		conn.Close()
		t.Fatal("stopped listener still accepts connections")
	}
}
