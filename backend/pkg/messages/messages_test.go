package messages_test

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/Koshsky/erp-backend/pkg/messages"
)

func TestParse(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name   string
		header string
		want   messages.Locale
	}{
		// Empty and unknown headers fall back to Russian (the default).
		{"empty", "", messages.LocaleRU},
		{"unknown", "de", messages.LocaleRU},
		{"wildcard", "*", messages.LocaleRU},
		{"zero q excluded", "en;q=0, ru", messages.LocaleRU},
		// Basic tags.
		{"ru", "ru", messages.LocaleRU},
		{"en", "en", messages.LocaleEN},
		{"en case insensitive", "EN", messages.LocaleEN},
		// Language subtags resolve to the base language.
		{"en-US", "en-US", messages.LocaleEN},
		{"ru-RU", "ru-RU", messages.LocaleRU},
		{"en-GB wins over lower ru", "ru;q=0.5, en-GB;q=0.9", messages.LocaleEN},
		// q weights: the higher preference wins.
		{"q prefers en", "ru;q=0.8, en;q=0.9", messages.LocaleEN},
		{"absent q is highest", "en;q=0.9, ru", messages.LocaleRU},
		// An unknown tag at the highest q falls back to the default.
		{"unknown beats lower en", "de, en;q=0.5", messages.LocaleRU},
		// A tie prefers a supported language over the unknown tag.
		{"tie prefers supported", "de;q=0.5, en;q=0.5", messages.LocaleEN},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := messages.Parse(tc.header); got != tc.want {
				t.Errorf("Parse(%q) = %q, want %q", tc.header, got, tc.want)
			}
		})
	}
}

func TestTextFallback(t *testing.T) {
	t.Parallel()
	// Russian-authored messages: RU keeps the authored text, EN translates.
	if got := messages.Text("задача не найдена", messages.LocaleRU); got != "задача не найдена" {
		t.Errorf("Text(RU) = %q", got)
	}
	if got := messages.Text("задача не найдена", messages.LocaleEN); got != "task not found" {
		t.Errorf("Text(EN) = %q, want %q", got, "task not found")
	}
	// English-authored delivery literals: RU translates, EN keeps the text.
	if got := messages.Text("invalid id", messages.LocaleRU); got != "неверный id" {
		t.Errorf("Text(RU invalid id) = %q, want %q", got, "неверный id")
	}
	if got := messages.Text("invalid id", messages.LocaleEN); got != "invalid id" {
		t.Errorf("Text(EN invalid id) = %q, want %q", got, "invalid id")
	}
	// A missing entry degrades to the key itself in both languages.
	if got := messages.Text("no-such-key", messages.LocaleRU); got != "no-such-key" {
		t.Errorf("Text(RU missing) = %q", got)
	}
	if got := messages.Text("no-such-key", messages.LocaleEN); got != "no-such-key" {
		t.Errorf("Text(EN missing) = %q", got)
	}
}

func TestRenderf(t *testing.T) {
	t.Parallel()
	gotRU := messages.Renderf("validator.max_days", messages.LocaleRU, 30)
	if gotRU != "период не должен превышать 30 дней" {
		t.Errorf("Renderf(RU) = %q", gotRU)
	}
	gotEN := messages.Renderf("validator.max_days", messages.LocaleEN, 30)
	if gotEN != "date range must not exceed 30 days" {
		t.Errorf("Renderf(EN) = %q", gotEN)
	}
	gotFsEN := messages.Renderf("task_dependency.finish_to_start", messages.LocaleEN, "Монтаж", "Подготовка")
	if gotFsEN != `task "Монтаж" must start no earlier than task "Подготовка" ends (finish-to-start link)` {
		t.Errorf("Renderf(EN fs) = %q", gotFsEN)
	}
	gotFsRU := messages.Renderf("task_dependency.finish_to_start", messages.LocaleRU, "Монтаж", "Подготовка")
	if gotFsRU != "задача «Монтаж» должна начинаться не раньше окончания задачи «Подготовка» (связь «окончание → начало»)" {
		t.Errorf("Renderf(RU fs) = %q", gotFsRU)
	}
}

func TestMessage(t *testing.T) {
	t.Parallel()
	m := messages.M("validator.required", "title")
	if got := m.Text(messages.LocaleRU); got != "поле title обязательно" {
		t.Errorf("Message.Text(RU) = %q", got)
	}
	if got := m.Text(messages.LocaleEN); got != "title is required" {
		t.Errorf("Message.Text(EN) = %q", got)
	}
	// A plain (non-parameterized) message key renders through the catalog.
	plain := messages.M("задача не найдена")
	if got := plain.Text(messages.LocaleEN); got != "task not found" {
		t.Errorf("plain.Text(EN) = %q", got)
	}
}

// TestCatalogsComplete is the completeness gate: both embedded JSON catalogs
// must parse and no translation value may be empty.
func TestCatalogsComplete(t *testing.T) {
	t.Parallel()
	for _, name := range []string{"catalog_ru.json", "catalog_en.json"} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			raw, err := os.ReadFile(name)
			if err != nil {
				t.Fatalf("read %s: %v", name, err)
			}
			var entries map[string]string
			if parseErr := json.Unmarshal(raw, &entries); parseErr != nil {
				t.Fatalf("parse %s: %v", name, parseErr)
			}
			for key, value := range entries {
				if strings.TrimSpace(value) == "" {
					t.Errorf("%s: empty translation for key %q", name, key)
				}
			}
		})
	}
}
