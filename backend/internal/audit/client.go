package audit

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/Koshsky/erp-backend/internal/config"
	userdto "github.com/Koshsky/erp-backend/internal/user/dto"
)

// HTTP limits and defaults for the Loki client.
const (
	// defaultClientTimeout applies when the config timeout is unset.
	defaultClientTimeout = 3 * time.Second
	// errBodyLimit caps the error response body read on failures.
	errBodyLimit = 1024
	// responseBodyLimit caps the query response body read (16 MiB).
	responseBodyLimit = 16 << 20
	// queryLimitCap caps the growing limit used for pagination (Loki has no
	// offset; a page beyond the cap is not resolvable in v1).
	queryLimitCap = 2000
	// maxPageSize caps a single page of the query.
	maxPageSize = 500
	// filterSlots is the initial capacity for the LogQL field-filter list.
	filterSlots = 4
	// defaultMatchCapacity is the initial slice capacity for resolved user ids.
	defaultMatchCapacity = 4
	// defaultQueryWindow is the time range queried when the UI passes no
	// from/to bounds (matches the Loki retention of 30 days).
	defaultQueryWindow = 30 * 24 * time.Hour
)

// Loki stream labels (low cardinality — high-cardinality values such as
// user/entity ids stay inside the JSON line, not in labels).
const (
	labelService = "service"
	labelKind    = "kind"
	labelEntity  = "entity"
	labelAction  = "action"

	serviceName = "erp"
	auditKind   = "audit"
)

// lokiPushRequest is the body of POST /loki/api/v1/push.
type lokiPushRequest struct {
	Streams []lokiPushStream `json:"streams"`
}

type lokiPushStream struct {
	Stream map[string]string `json:"stream"`
	Values [][2]string       `json:"values"` // [nanosecondTs, line]
}

// lokiQueryResponse is the body of GET /loki/api/v1/query_range.
type lokiQueryResponse struct {
	Status string `json:"status"`
	Data   struct {
		ResultType string `json:"resultType"`
		Result     []struct {
			Stream map[string]string `json:"stream"`
			Values [][2]string       `json:"values"` // [nanosecondTs, line]
		} `json:"result"`
	} `json:"data"`
}

// UserLookup resolves users by login/full name for the `user` audit filter
// and provides display-name enrichment (backed by the user service).
type UserLookup interface {
	ListAllUsers(ctx context.Context) ([]userdto.UserResponse, error)
}

// Client talks to Grafana Loki: pushes audit events (ingest) and queries them
// back (LogQL) for the admin UI.
type Client struct {
	logger  *slog.Logger
	baseURL string
	lookup  UserLookup // nil-safe: enrichment/filter are optional
	hc      *http.Client
}

// NewClient builds the Loki HTTP client.
func NewClient(logger *slog.Logger, cfg config.AuditConfig, lookup UserLookup) *Client {
	timeout := time.Duration(cfg.Timeout)
	if timeout <= 0 {
		timeout = defaultClientTimeout
	}
	return &Client{
		logger:  logger.With("component", "audit_client"),
		baseURL: cfg.URL,
		lookup:  lookup,
		hc:      &http.Client{Timeout: timeout},
	}
}

// Send pushes one event to Loki as a single log entry. The event is already
// masked by the middleware before reaching this point.
func (c *Client) Send(ctx context.Context, ev Event) error {
	if c.baseURL == "" {
		return fmt.Errorf("loki URL is not configured")
	}
	ts := parseEventTS(ev.TS)
	line, err := json.Marshal(ev)
	if err != nil {
		return fmt.Errorf("marshal audit event: %w", err)
	}
	payload := lokiPushRequest{Streams: []lokiPushStream{{
		Stream: map[string]string{
			labelService: serviceName,
			labelKind:    auditKind,
			labelEntity:  ev.Entity,
			labelAction:  ev.Action,
		},
		Values: [][2]string{{strconv.FormatInt(ts.UnixNano(), 10), string(line)}},
	}}}
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal loki push payload: %w", err)
	}

	req, reqErr := http.NewRequestWithContext(
		ctx, http.MethodPost,
		c.baseURL+"/loki/api/v1/push", bytes.NewReader(body),
	)
	if reqErr != nil {
		return fmt.Errorf("build loki push request: %w", reqErr)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, doErr := c.hc.Do(req)
	if doErr != nil {
		return fmt.Errorf("loki push: %w", doErr)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, errBodyLimit))
		return fmt.Errorf("loki push status %d: %s", resp.StatusCode, bytes.TrimSpace(raw))
	}
	return nil
}

// List queries Loki audit events via LogQL query_range. The returned items
// are the decoded event view objects (newest first); total is the number of
// items actually returned (Loki provides no exact count — the UI treats it as
// a page-size hint).
func (c *Client) List(ctx context.Context, params url.Values) (json.RawMessage, int64, int, int, error) {
	if c.baseURL == "" {
		return nil, 0, 0, 0, fmt.Errorf("loki URL is not configured")
	}
	limit, offset := parseListPage(params)

	// Resolve the `user` filter (login / full name substring) to user ids via
	// the users table (equality on actor_user_id is reliable in Loki).
	var userIDs []int64
	if raw := strings.TrimSpace(params.Get("user")); raw != "" {
		userIDs = c.resolveUserIDs(ctx, raw)
		if len(userIDs) == 0 {
			items, _ := json.Marshal([]lokiView{})
			return items, 0, limit, offset, nil
		}
	}

	qp := url.Values{}
	qp.Set("query", buildLogQL(params, userIDs))
	start, end := queryWindow(params)
	qp.Set("start", strconv.FormatInt(start.UnixNano(), 10))
	qp.Set("end", strconv.FormatInt(end.UnixNano(), 10))
	qp.Set("limit", strconv.Itoa(min(offset+limit, queryLimitCap)))
	qp.Set("direction", "backward")

	req, reqErr := http.NewRequestWithContext(
		ctx, http.MethodGet,
		c.baseURL+"/loki/api/v1/query_range?"+qp.Encode(), nil,
	)
	if reqErr != nil {
		return nil, 0, 0, 0, fmt.Errorf("build loki query request: %w", reqErr)
	}

	resp, doErr := c.hc.Do(req)
	if doErr != nil {
		return nil, 0, 0, 0, fmt.Errorf("loki query: %w", doErr)
	}
	defer func() { _ = resp.Body.Close() }()

	raw, readErr := io.ReadAll(io.LimitReader(resp.Body, responseBodyLimit))
	if readErr != nil {
		return nil, 0, 0, 0, fmt.Errorf("read loki query response: %w", readErr)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, 0, 0, 0, fmt.Errorf("loki query status %d: %s", resp.StatusCode, bytes.TrimSpace(raw))
	}

	var lr lokiQueryResponse
	if err := json.Unmarshal(raw, &lr); err != nil {
		return nil, 0, 0, 0, fmt.Errorf("decode loki query response: %w", err)
	}

	lines := collectLines(lr)
	views := slicePage(lines, offset, limit)
	c.enrichNames(ctx, views)
	items, _ := json.Marshal(views)
	return items, int64(len(views)), limit, offset, nil
}

// resolveUserIDs matches the filter text (case-insensitive substring) against
// user logins and full names from the live users table. Deleted users are
// physically removed (archived), so they are not included here.
func (c *Client) resolveUserIDs(ctx context.Context, text string) []int64 {
	if c.lookup == nil {
		return nil
	}
	users, err := c.lookup.ListAllUsers(ctx)
	if err != nil {
		c.logger.ErrorContext(ctx, "audit user lookup failed", "error", err)
		return nil
	}
	needle := strings.ToLower(strings.TrimSpace(text))
	ids := make([]int64, 0, defaultMatchCapacity)
	for _, u := range users {
		if matchUser(u, needle) {
			ids = append(ids, u.ID)
		}
	}
	return ids
}

// matchUser reports whether the user matches the needle (case-insensitive
// substring against the username, composed name, or any name part).
func matchUser(u userdto.UserResponse, needle string) bool {
	needle = strings.ToLower(strings.TrimSpace(needle))
	if needle == "" {
		return false
	}
	if containsFold(u.Username, needle) || containsFold(u.Name, needle) ||
		containsFold(u.LastName, needle) || containsFold(u.FirstName, needle) {
		return true
	}
	return u.MiddleName != nil && containsFold(*u.MiddleName, needle)
}

// containsFold reports a case-insensitive substring match.
func containsFold(haystack, needle string) bool {
	return strings.Contains(strings.ToLower(haystack), needle)
}

// enrichNames fills actor_name from the users table (once per request) so the
// UI can show the full name next to the login. When the event has no actor
// login (e.g. auth/refresh with an empty body) it is filled from the users
// table too. Nil lookup — no-op.
func (c *Client) enrichNames(ctx context.Context, views []lokiView) {
	if c.lookup == nil || len(views) == 0 {
		return
	}
	users, err := c.lookup.ListAllUsers(ctx)
	if err != nil {
		c.logger.ErrorContext(ctx, "audit name enrichment failed", "error", err)
		return
	}
	type userInfo struct {
		name     string
		username string
	}
	byID := make(map[int64]userInfo, len(users))
	for _, u := range users {
		byID[u.ID] = userInfo{name: u.Name, username: u.Username}
	}
	for i := range views {
		if views[i].ActorUserID == nil {
			continue
		}
		info, ok := byID[*views[i].ActorUserID]
		if !ok {
			continue
		}
		views[i].ActorName = info.name
		if views[i].ActorEmail == "" {
			views[i].ActorEmail = info.username
		}
	}
}

// parseListPage reads the limit/offset params with defaults and caps.
func parseListPage(params url.Values) (int, int) {
	limit := 50
	if raw := params.Get("limit"); raw != "" {
		if v, err := strconv.Atoi(raw); err == nil && v > 0 {
			limit = min(v, maxPageSize)
		}
	}
	offset := 0
	if raw := params.Get("offset"); raw != "" {
		if v, err := strconv.Atoi(raw); err == nil && v > 0 {
			offset = v
		}
	}
	return limit, offset
}

// collectLines flattens the Loki result streams into entries, newest first
// (direction=backward sorts per stream; we re-sort across streams by ts).
func collectLines(lr lokiQueryResponse) []entry {
	lines := make([]entry, 0)
	for _, stream := range lr.Data.Result {
		for _, v := range stream.Values {
			lines = append(lines, entry{ts: v[0], line: v[1]})
		}
	}
	sort.Slice(lines, func(i, j int) bool { return lines[i].ts > lines[j].ts })
	return lines
}

// slicePage extracts [offset, offset+limit) and decodes the lines into views.
func slicePage(lines []entry, offset, limit int) []lokiView {
	if offset >= len(lines) {
		return []lokiView{}
	}
	endIdx := min(offset+limit, len(lines))
	page := lines[offset:endIdx]

	views := make([]lokiView, 0, len(page))
	for i, e := range page {
		var v lokiView
		if err := json.Unmarshal([]byte(e.line), &v); err != nil {
			continue
		}
		v.ID = int64(offset + i + 1)
		views = append(views, v)
	}
	return views
}

// entry is a raw Loki log line with its index timestamp (nanoseconds string).
type entry struct {
	ts   string
	line string
}

// lokiView is the decoded event line (the swagger model is dto.AuditEventView;
// the JSON shape matches it plus the synthetic page-local id).
type lokiView struct {
	ID           int64           `json:"id"`
	TS           string          `json:"ts"`
	ActorUserID  *int64          `json:"actor_user_id,omitempty"`
	ActorName    string          `json:"actor_name,omitempty"`
	ActorEmail   string          `json:"actor_email,omitempty"`
	ActorRole    string          `json:"actor_role,omitempty"`
	ActorIP      string          `json:"actor_ip,omitempty"`
	Entity       string          `json:"entity"`
	Action       string          `json:"action"`
	EntityID     *int64          `json:"entity_id,omitempty"`
	Method       string          `json:"method"`
	Path         string          `json:"path"`
	Status       int             `json:"status"`
	DurationMS   *int            `json:"duration_ms,omitempty"`
	RequestBody  json.RawMessage `json:"request_body,omitempty"`
	ResponseBody json.RawMessage `json:"response_body,omitempty"`
}

// buildLogQL assembles the LogQL query from the UI filter params.
//
// Search is implemented as a case-insensitive line filter on the raw JSON
// (substring match across all fields, incl. user names): regex label filters
// (`path =~ ...`) are unreliable on fields extracted by `| json` in our Loki
// version, while line filters always match. Entity/action go into the stream
// selector (labels), user_id/status are equality filters on extracted fields.
// The `user` filter arrives already resolved to user ids (equality OR-filter).
func buildLogQL(params url.Values, userIDs []int64) string {
	var sb strings.Builder
	sb.WriteString(`{`)
	sb.WriteString(labelService + `="` + serviceName + `",` + labelKind + `="` + auditKind + `"`)
	if e := params.Get("entity"); e != "" {
		sb.WriteString(`,` + labelEntity + `="` + QuoteLabel(e) + `"`)
	}
	if a := params.Get("action"); a != "" {
		sb.WriteString(`,` + labelAction + `="` + QuoteLabel(a) + `"`)
	}
	sb.WriteString(`}`)

	// Line filter first (cheap, applied before parsing). Search is a
	// case-insensitive substring match over the raw JSON line.
	if s := strings.TrimSpace(params.Get("search")); s != "" {
		sb.WriteString(` |~ "(?i)` + escapeRegexLiteral(s) + `"`)
	}

	// Parse the line JSON, strip non-JSON entries, then apply field filters.
	sb.WriteString(` | json | __error__=""`)

	filters := fieldFilters(params, userIDs)
	if len(filters) > 0 {
		sb.WriteString(` | ` + strings.Join(filters, " | "))
	}
	return sb.String()
}

// fieldFilters assembles the equality field filters (id, ip, user ids, status).
// Boolean OR groups are used where an extracted field value may vary between
// events, since regex (=~) label filters are unreliable in our Loki version.
func fieldFilters(params url.Values, userIDs []int64) []string {
	filters := make([]string, 0, filterSlots)
	// IP is an exact equality on the actor_ip field (a whole-line substring
	// would match unrelated fields, e.g. "99" hitting any body/duration value —
	// substring matching is only appropriate for `search`, where matching
	// anywhere in the event is the intent).
	if ip := strings.TrimSpace(params.Get("ip")); ip != "" {
		filters = append(filters, `actor_ip="`+QuoteLabel(ip)+`"`)
	}

	// The ID column shows entity_id ?? actor_user_id — matching the display.
	if id := params.Get("id"); id != "" {
		if _, err := strconv.ParseInt(id, 10, 64); err == nil {
			filters = append(filters, `(entity_id="`+id+`" or actor_user_id="`+id+`")`)
		}
	}
	if len(userIDs) > 0 {
		ids := make([]string, 0, len(userIDs))
		for _, id := range userIDs {
			ids = append(ids, strconv.FormatInt(id, 10))
		}
		filters = append(filters, orGroup("actor_user_id", ids))
	}
	if uid := params.Get("user_id"); uid != "" {
		if _, err := strconv.ParseInt(uid, 10, 64); err == nil {
			filters = append(filters, `actor_user_id="`+uid+`"`)
		}
	}
	if st := params.Get("status"); st != "" {
		if codes, ok := statusGroupCodes(st); ok {
			// Group ("2xx"/"3xx"/"4xx"/"5xx") → OR-equality of the group's codes.
			filters = append(filters, orGroup("status", codes))
		} else if _, err := strconv.Atoi(st); err == nil {
			// Exact code (back-compat).
			filters = append(filters, `status="`+st+`"`)
		}
	}
	return filters
}

// orGroup assembles `(field="a" or field="b" or ...)` from string codes.
func orGroup(field string, values []string) string {
	eq := make([]string, 0, len(values))
	for _, v := range values {
		eq = append(eq, field+`="`+v+`"`)
	}
	return `(` + strings.Join(eq, " or ") + `)`
}

// escapeRegexLiteral quotes a search term so it matches literally inside a
// quoted LogQL regex. Two layers of escaping: regexp metacharacters get a
// backslash for RE2, and then every backslash and quote is doubled/escaped for
// the double-quoted LogQL string (a bare `\.` is rejected by LogQL's parser
// as an invalid escape).
func escapeRegexLiteral(s string) string {
	escaped := regexp.QuoteMeta(s)
	escaped = strings.ReplaceAll(escaped, `\`, `\\`)
	return strings.ReplaceAll(escaped, `"`, `\"`)
}

// statusGroups maps an HTTP status group ("2xx"…"5xx") to the exact codes
// that make it up (statuses observed in the API plus common ones).
//
//nolint:gochecknoglobals // static status-group table (established pattern)
var statusGroups = map[string][]string{
	"2xx": {"200", "201", "204"},
	"3xx": {"300", "301", "302", "304", "307", "308"},
	"4xx": {"400", "401", "403", "404", "405", "409", "410", "415", "422", "429"},
	"5xx": {"500", "501", "502", "503", "504"},
}

// statusGroupCodes returns the exact codes of a status group, if known.
func statusGroupCodes(group string) ([]string, bool) {
	codes, ok := statusGroups[group]
	return codes, ok
}

// queryWindow resolves the [start, end] range: from the UI bounds or the
// default window (retention-sized, ending now).
func queryWindow(params url.Values) (time.Time, time.Time) {
	now := time.Now().UTC()
	start := now.Add(-defaultQueryWindow)
	end := now
	if f := params.Get("from"); f != "" {
		if t, err := time.Parse(time.RFC3339, f); err == nil {
			start = t.UTC()
		}
	}
	if t := params.Get("to"); t != "" {
		if tt, err := time.Parse(time.RFC3339, t); err == nil {
			end = tt.UTC()
		}
	}
	return start, end
}

// parseEventTS converts the event's RFC3339 string back to time (Loki push
// index). Falls back to now on unparseable/empty input.
func parseEventTS(ts string) time.Time {
	if ts == "" {
		return time.Now().UTC()
	}
	t, err := time.Parse(time.RFC3339, ts)
	if err != nil {
		return time.Now().UTC()
	}
	return t.UTC()
}

// QuoteLabel escapes a label value for the LogQL label matcher.
func QuoteLabel(v string) string {
	return strings.ReplaceAll(v, `"`, `\"`)
}
