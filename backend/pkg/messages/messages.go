// Package messages holds the RU/EN message catalogs and the per-request
// locale negotiation for user-facing API texts. Russian is the source of truth
// and the default locale; English is the translation. Non-parameterized
// messages are addressed by their authored source text (the key IS the text),
// parameterized messages by a stable template id.
package messages

import (
	"embed"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"sync"
)

//go:embed catalog_ru.json catalog_en.json
var catalogFiles embed.FS

// catalog is the parsed RU/EN message catalog, built exactly once on the first
// translation lookup (see parseCatalog).
var catalog = sync.OnceValue(parseCatalog) //nolint:gochecknoglobals // read-only parsed catalogs, once at first use

// Locale is a supported UI language code.
type Locale string

const (
	// LocaleRU is the Russian locale (the product default).
	LocaleRU Locale = "ru"

	// LocaleEN is the English locale.
	LocaleEN Locale = "en"
)

// Default is the locale used when the request carries no usable preference.
const Default = LocaleRU

// Parse resolves an Accept-Language header into a Locale, honoring q weights
// and language subtags ("en-US" resolves to "en", "ru-RU" to "ru"). Unknown
// tags fall back to [Default]; an explicit known tag with a lower q never
// beats a higher-preferred one, and a tie prefers a supported language.
func Parse(header string) Locale {
	best := Default
	bestQ := 0.0
	for part := range strings.SplitSeq(header, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		lang, q := splitQ(part)
		if q <= 0 {
			continue
		}
		loc := resolve(lang)
		if q > bestQ || (q == bestQ && loc != Default) {
			best = loc
			bestQ = q
		}
	}
	return best
}

// splitQ separates a single Accept-Language element into its language tag and
// the q weight (absent by default).
func splitQ(part string) (string, float64) {
	var rest string
	if i := strings.IndexByte(part, ';'); i >= 0 {
		rest = part[i+1:]
		part = part[:i]
	} else {
		rest = ""
	}
	if rest != "" {
		for param := range strings.SplitSeq(rest, ";") {
			name, value, found := strings.Cut(strings.TrimSpace(param), "=")
			if found && strings.EqualFold(strings.TrimSpace(name), "q") {
				if v, err := strconv.ParseFloat(strings.TrimSpace(value), 64); err == nil {
					return strings.TrimSpace(part), v
				}
				return strings.TrimSpace(part), 0
			}
		}
	}
	// An absent weight means the highest preference.
	return strings.TrimSpace(part), 1
}

// resolve maps a language tag to the supported Locale; an unknown tag returns
// [Default]. Tags are matched case-insensitively per the header conventions.
func resolve(lang string) Locale {
	lang = strings.ToLower(lang)
	switch {
	case strings.HasPrefix(lang, "en"):
		return LocaleEN
	case strings.HasPrefix(lang, "ru"):
		return LocaleRU
	default:
		return Default
	}
}

// Text returns the translation of key for the locale. A missing entry returns
// the key unchanged: for non-parameterized messages the key IS the authored
// source text, so an untranslated string degrades to the source rather than to
// a placeholder.
func Text(key string, l Locale) string {
	entries := catalog().ru
	if l == LocaleEN {
		entries = catalog().en
	}
	if translated, ok := entries[key]; ok {
		return translated
	}
	return key
}

// Renderf renders a parameterized message: it resolves key through [Text] and
// then applies [fmt.Sprintf] with args. The key is a stable template id (for
// example "task_dependency.finish_to_start"), never a message text.
func Renderf(key string, l Locale, args ...any) string {
	return fmt.Sprintf(Text(key, l), args...)
}

// Message is a locale-agnostic reference to a message: a catalog key plus the
// arguments for its template. It is rendered per locale via Message.Text.
type Message struct {
	Key  string
	Args []any
}

// M builds a Message from a catalog key and optional template arguments.
func M(key string, args ...any) Message {
	return Message{Key: key, Args: args}
}

// Text renders the message for the locale: a template message (with args) goes
// through Renderf, a plain message through the catalog lookup of its key.
func (m Message) Text(l Locale) string {
	if m.Args == nil {
		return Text(m.Key, l)
	}
	return Renderf(m.Key, l, m.Args...)
}

// catalogs is the parsed key->text table for both languages.
type catalogs struct {
	ru map[string]string
	en map[string]string
}

// parseCatalog reads and parses the two embedded catalog files. A malformed
// embedded catalog is a build defect, so it fails loudly.
func parseCatalog() catalogs {
	return catalogs{
		ru: parseCatalogFile("catalog_ru.json"),
		en: parseCatalogFile("catalog_en.json"),
	}
}

// parseCatalogFile loads and parses one embedded catalog JSON file.
func parseCatalogFile(name string) map[string]string {
	raw, err := catalogFiles.ReadFile(name)
	if err != nil {
		panic("messages: cannot read embedded catalog " + name + ": " + err.Error())
	}
	var entries map[string]string
	if err = json.Unmarshal(raw, &entries); err != nil {
		panic("messages: malformed catalog " + name + ": " + err.Error())
	}
	return entries
}
