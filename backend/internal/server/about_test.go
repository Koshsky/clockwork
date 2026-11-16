//nolint:testpackage // The handler uses the application's injected release version.
package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	release "github.com/Koshsky/erp-backend"
)

func TestApplicationInfo(t *testing.T) {
	t.Parallel()

	app := &App{}
	app.SetVersion("9.7.3")
	router := gin.New()
	router.GET("/about", app.applicationInfo)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/about", nil))

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if recorder.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("release metadata must not be cached by HTTP intermediaries")
	}

	var envelope struct {
		Data release.Info `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Data.Version != "9.7.3" {
		t.Fatalf("version = %q", envelope.Data.Version)
	}
	if !strings.Contains(envelope.Data.ChangelogRU, "## [") ||
		!strings.Contains(envelope.Data.ChangelogEN, "## [") ||
		envelope.Data.ChangelogRU == envelope.Data.ChangelogEN {
		t.Fatal("response must include both localized release notes")
	}
}
