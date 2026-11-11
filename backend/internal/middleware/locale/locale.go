// Package locale resolves the per-request UI language from the Accept-Language
// header and stores it on the gin context so the response layer can render
// user-facing messages in the client's language.
package locale

import (
	"github.com/gin-gonic/gin"

	"github.com/Koshsky/erp-backend/pkg/messages"
)

// contextKey is the gin context key under which the resolved locale is stored.
const contextKey = "locale"

// Middleware returns a gin handler that resolves the request language from the
// Accept-Language header (see messages.Parse), stores the Locale on the gin
// context, and declares Vary: Accept-Language so caches keep per-language
// response variants separate.
func Middleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Set(contextKey, messages.Parse(c.GetHeader("Accept-Language")))
		c.Header("Vary", "Accept-Language")
		c.Next()
	}
}

// FromGin returns the request's resolved locale, defaulting to [messages.Default] when
// the middleware did not run or the header carried no usable preference.
func FromGin(c *gin.Context) messages.Locale {
	if raw, isSet := c.Get(contextKey); isSet {
		if l, isLocale := raw.(messages.Locale); isLocale {
			return l
		}
	}
	return messages.Default
}
