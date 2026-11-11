package response_test

import (
	"encoding/json"
	stderrors "errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/Koshsky/erp-backend/internal/middleware/locale"
	"github.com/Koshsky/erp-backend/internal/response"
	"github.com/Koshsky/erp-backend/pkg/errors"
	"github.com/Koshsky/erp-backend/pkg/messages"
)

type body struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type envelope struct {
	Error *body `json:"error"`
}

// run serves the given handler through a real gin router (with the locale
// middleware mounted) and returns the body; acceptLanguage is sent as the
// Accept-Language header.
func run(t *testing.T, acceptLanguage string, handler gin.HandlerFunc) envelope {
	t.Helper()
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(locale.Middleware())
	router.Any("/test", handler)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	if acceptLanguage != "" {
		req.Header.Set("Accept-Language", acceptLanguage)
	}
	router.ServeHTTP(rec, req)

	var env envelope
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("unmarshal response: %v (body=%s)", err, rec.Body.String())
	}
	return env
}

func TestInternalErrorSendsGeneric(t *testing.T) {
	t.Parallel()
	logger := slog.New(slog.NewTextHandler(&strings.Builder{}, nil))
	env := run(t, "", func(c *gin.Context) {
		response.InternalError(c, logger, "db: failed", stderrors.New("connection refused"))
	})

	if env.Error == nil {
		t.Fatal("expected error envelope")
	}
	if env.Error.Code != "INTERNAL_ERROR" {
		t.Errorf("code = %q, want INTERNAL_ERROR", env.Error.Code)
	}
	// The 500 body renders the localized generic message: Russian by default.
	if env.Error.Message != "Внутренняя ошибка сервера" {
		t.Errorf("message = %q, want %q", env.Error.Message, "Внутренняя ошибка сервера")
	}
	if strings.Contains(env.Error.Message, "db") || strings.Contains(env.Error.Message, "refused") {
		t.Errorf("internal details leaked: %q", env.Error.Message)
	}
}

func TestErrorSendsGenericOn500(t *testing.T) {
	t.Parallel()
	logger := slog.New(slog.NewTextHandler(&strings.Builder{}, nil))
	env := run(t, "", func(c *gin.Context) {
		response.Error(c, logger, stderrors.New("dial tcp 10.0.0.1:5432: connect: connection refused"))
	})

	if env.Error.Code != "INTERNAL_ERROR" {
		t.Errorf("code = %q, want INTERNAL_ERROR", env.Error.Code)
	}
	if env.Error.Message != "Внутренняя ошибка сервера" {
		t.Errorf("message = %q, want %q", env.Error.Message, "Внутренняя ошибка сервера")
	}
	if strings.Contains(env.Error.Message, "dial") || strings.Contains(env.Error.Message, "5432") {
		t.Errorf("internal details leaked: %q", env.Error.Message)
	}
}

func TestErrorKeepsDomainMessageOn4xx(t *testing.T) {
	t.Parallel()
	logger := slog.New(slog.NewTextHandler(&strings.Builder{}, nil))
	env := run(t, "", func(c *gin.Context) {
		response.Error(c, logger, errors.NotFound("user missing"))
	})

	if env.Error.Code != "NOT_FOUND" {
		t.Errorf("code = %q, want NOT_FOUND", env.Error.Code)
	}
	// "user missing" has no catalog entry, so the authored text is kept.
	if env.Error.Message != "user missing" {
		t.Errorf("message = %q, want %q", env.Error.Message, "user missing")
	}
}

// TestErrorRendersPerLocale is the localization proof: the same domain error
// renders Russian for ru (and for no header) and English for en.
func TestErrorRendersPerLocale(t *testing.T) {
	t.Parallel()
	logger := slog.New(slog.NewTextHandler(&strings.Builder{}, nil))

	// A Russian-authored message: RU stays authored, EN resolves via catalog.
	ruDefault := run(t, "", func(c *gin.Context) {
		response.Error(c, logger, errors.NotFound("задача не найдена"))
	})
	if ruDefault.Error.Message != "задача не найдена" {
		t.Errorf("no header: message = %q, want %q", ruDefault.Error.Message, "задача не найдена")
	}
	ruExplicit := run(t, "ru", func(c *gin.Context) {
		response.Error(c, logger, errors.NotFound("задача не найдена"))
	})
	if ruExplicit.Error.Message != "задача не найдена" {
		t.Errorf("ru: message = %q, want %q", ruExplicit.Error.Message, "задача не найдена")
	}
	en := run(t, "en", func(c *gin.Context) {
		response.Error(c, logger, errors.NotFound("задача не найдена"))
	})
	if en.Error.Message != "task not found" {
		t.Errorf("en: message = %q, want %q", en.Error.Message, "task not found")
	}

	// An English-authored delivery literal: the RU catalog translates it.
	ruLiteral := run(t, "", func(c *gin.Context) {
		response.BadRequest(c, errors.CodeBadRequest, "invalid id")
	})
	if ruLiteral.Error.Message != "неверный id" {
		t.Errorf("ru literal: message = %q, want %q", ruLiteral.Error.Message, "неверный id")
	}
	enLiteral := run(t, "en", func(c *gin.Context) {
		response.BadRequest(c, errors.CodeBadRequest, "invalid id")
	})
	if enLiteral.Error.Message != "invalid id" {
		t.Errorf("en literal: message = %q, want %q", enLiteral.Error.Message, "invalid id")
	}
}

// TestErrorRendersParameterizedMessage proves the template re-rendering per
// locale for errors carrying MsgKey/MsgArgs.
func TestErrorRendersParameterizedMessage(t *testing.T) {
	t.Parallel()
	logger := slog.New(slog.NewTextHandler(&strings.Builder{}, nil))

	wantRU := "период не должен превышать 30 дней"
	wantEN := "date range must not exceed 30 days"

	ru := run(t, "ru", func(c *gin.Context) {
		response.Error(c, logger, errors.NewValidationErrorM(messages.M("validator.max_days", 30)))
	})
	if ru.Error.Message != wantRU {
		t.Errorf("ru: message = %q, want %q", ru.Error.Message, wantRU)
	}

	en := run(t, "en", func(c *gin.Context) {
		response.Error(c, logger, errors.NewValidationErrorM(messages.M("validator.max_days", 30)))
	})
	if en.Error.Message != wantEN {
		t.Errorf("en: message = %q, want %q", en.Error.Message, wantEN)
	}
}
