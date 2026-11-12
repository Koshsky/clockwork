//nolint:testpackage // White-box tests inject the auth service boundary without a database.
package delivery

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"reflect"

	"github.com/gin-gonic/gin"

	"github.com/Koshsky/erp-backend/internal/auth/dto"
)

type browserAuth struct {
	token string
	calls int
}

func (s *browserAuth) Login(context.Context, string, string) (*dto.SessionResult, error) {
	s.calls++
	return &dto.SessionResult{Auth: &dto.AuthResponse{AccessToken: "access"}, RefreshToken: "rotated"}, nil
}
func (s *browserAuth) RefreshToken(_ context.Context, token string) (*dto.SessionResult, error) {
	s.token = token
	return s.Login(context.Background(), "", "")
}
func (s *browserAuth) Logout(_ context.Context, token string) error {
	s.calls++
	s.token = token
	return nil
}

func TestBrowserSessionOrigins(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name, origin, site  string
		cookieOnly, allowed bool
	}{
		{"native", "", "", false, true},
		{"native-fetch", "", "none", false, true},
		{"cookie-native", "", "", true, true},
		{"proxy-same-origin", "https://public.example", "same-origin", true, true},
		{"legacy-same-origin", "http://api.example", "", true, true},
		{"cross-site", "https://evil.example", "cross-site", true, false},
		{"same-site-subdomain", "https://other.example", "same-site", true, false},
		{"malformed", "://", "cross-site", true, false},
		{"userinfo", "http://name@api.example", "", true, false},
		{"desktop", "http://127.0.0.1:31880", "cross-site", false, true},
		{"desktop-last", "http://localhost:31899", "cross-site", false, true},
		{"desktop-cookie-denied", "http://127.0.0.1:31880", "cross-site", true, false},
		{"wrong-desktop-port", "http://localhost:31900", "cross-site", false, false},
		{"untrusted-login", "https://evil.example", "cross-site", false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			c, _ := gin.CreateTestContext(httptest.NewRecorder())
			c.Request = httptest.NewRequest(http.MethodPost, "http://api.example/api/v1/auth/refresh", nil)
			c.Request.Header.Set("Origin", tc.origin)
			c.Request.Header.Set("Sec-Fetch-Site", tc.site)
			sessionEqual(t, tc.allowed, browserSessionAllowed(c, tc.cookieOnly))
		})
	}
}
func TestBrowserCookieTransport(t *testing.T) {
	t.Parallel()
	for _, endpoint := range []string{"login", "refresh", "logout"} {
		for _, cookie := range []bool{false, true} {
			t.Run(endpoint+"/"+map[bool]string{true: "cookie", false: "body"}[cookie], func(t *testing.T) {
				t.Parallel()
				service := &browserAuth{}
				handler := &AuthHandler{service: service}
				router := gin.New()
				router.POST("/login", handler.Login)
				router.POST("/refresh", handler.RefreshToken)
				router.POST("/logout", handler.Logout)
				body := `{"username":"admin","password":"test-password"}`
				if endpoint != "login" {
					body = `{"refresh_token":"ignored-body-token"}`
					if !cookie {
						body = `{"refresh_token":"body-token"}`
					}
				}
				request := httptest.NewRequest(http.MethodPost, "/"+endpoint, strings.NewReader(body))
				request.Header.Set("Content-Type", "application/json")
				request.AddCookie(&http.Cookie{Name: refreshCookieName, Value: "cookie-token"})
				if cookie {
					request.Header.Set(sessionTransportHeader, sessionTransportCookie)
				}
				recorder := httptest.NewRecorder()
				router.ServeHTTP(recorder, request)
				sessionEqual(t, http.StatusOK, recorder.Code)
				sessionEqual(t, "no-store", recorder.Header().Get("Cache-Control"))
				cookies := recorder.Result().Cookies()
				sessionEqual(t, 1, len(cookies))
				sessionEqual(t, true, cookies[0].HttpOnly)
				sessionEqual(t, http.SameSiteStrictMode, cookies[0].SameSite)
				sessionEqual(t, refreshCookiePath, cookies[0].Path)
				assertBrowserResponse(t, endpoint, cookie, recorder, service)
			})
		}
	}
}
func TestCrossSiteAuthNeverCallsService(t *testing.T) {
	t.Parallel()
	for _, endpoint := range []string{"login", "refresh", "logout"} {
		t.Run(endpoint, func(t *testing.T) {
			t.Parallel()
			service := &browserAuth{}
			handler := &AuthHandler{service: service}
			router := gin.New()
			router.POST("/login", handler.Login)
			router.POST("/refresh", handler.RefreshToken)
			router.POST("/logout", handler.Logout)
			request := httptest.NewRequest(
				http.MethodPost,
				"/"+endpoint,
				strings.NewReader(`{"username":"admin","password":"password"}`),
			)
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Origin", "https://evil.example")
			request.Header.Set("Sec-Fetch-Site", "cross-site")
			request.AddCookie(&http.Cookie{Name: refreshCookieName, Value: "never-consume"})
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, request)
			sessionEqual(t, http.StatusForbidden, recorder.Code)
			sessionEqual(t, 0, service.calls)
			sessionEqual(t, 0, len(recorder.Result().Cookies()))
		})
	}
}

func sessionEqual(t *testing.T, want, got any) {
	t.Helper()
	if !reflect.DeepEqual(want, got) {
		t.Fatalf("want %#v, got %#v", want, got)
	}
}

func assertBrowserResponse(
	t *testing.T,
	endpoint string,
	cookie bool,
	recorder *httptest.ResponseRecorder,
	service *browserAuth,
) {
	t.Helper()
	cookies := recorder.Result().Cookies()
	if endpoint == "logout" {
		sessionEqual(t, -1, cookies[0].MaxAge)
	} else {
		var payload struct {
			Data map[string]any `json:"data"`
		}
		sessionEqual(t, nil, json.Unmarshal(recorder.Body.Bytes(), &payload))
		if cookie {
			_, exists := payload.Data["refresh_token"]
			sessionEqual(t, false, exists)
		} else {
			sessionEqual(t, "rotated", payload.Data["refresh_token"])
		}
	}
	if endpoint != "login" {
		if cookie {
			sessionEqual(t, "cookie-token", service.token)
		} else {
			sessionEqual(t, "body-token", service.token)
		}
	}
}
