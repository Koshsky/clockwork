//nolint:testpackage // tests the unexported user-matcher directly
package audit

import (
	"context"
	"testing"

	userdto "github.com/Koshsky/erp-backend/internal/user/dto"
)

func TestMatchUser(t *testing.T) {
	t.Parallel()
	u := userdto.UserResponse{
		ID:         3,
		Username:   "ivanov.ii",
		Name:       "Иванов Иван",
		LastName:   "Иванов",
		FirstName:  "Иван",
		MiddleName: new("Иванович"),
	}
	cases := []struct {
		needle string
		want   bool
	}{
		{"ivanov", true},      // login substring
		{"IVANOV", true},      // login upper-case
		{"иванов", true},      // last name
		{"Иван", true},        // first name
		{"Иванович", true},    // middle name
		{"Иванов Иван", true}, // composed name
		{"петров", false},     // no match
		{"", false},
	}
	for _, tc := range cases {
		if got := matchUser(u, tc.needle); got != tc.want {
			t.Fatalf("matchUser(%q) = %v, want %v", tc.needle, got, tc.want)
		}
	}
}

// stubLookup implements UserLookup with a fixed user list.
type stubLookup struct{ users []userdto.UserResponse }

func (s *stubLookup) ListAllUsers(context.Context) ([]userdto.UserResponse, error) {
	return s.users, nil
}

func TestResolveUserIDsCaseInsensitive(t *testing.T) {
	t.Parallel()
	lk := &stubLookup{users: []userdto.UserResponse{
		{ID: 1, Username: "admin", Name: "Admin Name", LastName: "Admin", FirstName: "Name"},
		{ID: 2, Username: "ivanov.ii", Name: "Иванов Иван", LastName: "Иванов", FirstName: "Иван"},
	}}
	c := &Client{lookup: lk}

	cases := []struct {
		text string
		want []int64
	}{
		{"IVANOV", []int64{2}},      // case-insensitive login
		{"admin", []int64{1}},       // exact login
		{"Иванов Иван", []int64{2}}, // by full name
		{"неттакого", nil},
		{"", nil},
	}
	for _, tc := range cases {
		got := c.resolveUserIDs(context.Background(), tc.text)
		if len(got) != len(tc.want) {
			t.Fatalf("resolveUserIDs(%q) = %v, want %v", tc.text, got, tc.want)
		}
		for i := range got {
			if got[i] != tc.want[i] {
				t.Fatalf("resolveUserIDs(%q) = %v, want %v", tc.text, got, tc.want)
			}
		}
	}
}

func TestEnrichNamesFillsNameAndLogin(t *testing.T) {
	t.Parallel()
	lk := &stubLookup{users: []userdto.UserResponse{
		{ID: 1, Username: "admin", Name: "Admin Name", LastName: "Admin", FirstName: "Name"},
	}}
	c := &Client{lookup: lk}

	views := []lokiView{
		{ActorUserID: new(int64(1)), ActorEmail: "admin"}, // login already known
		{ActorUserID: new(int64(1))},                      // refresh: no email in event
		{ActorUserID: nil, ActorEmail: "unknown@x.ru"},    // no id — untouched
	}
	c.enrichNames(context.Background(), views)

	if views[0].ActorName != "Admin Name" || views[0].ActorEmail != "admin" {
		t.Fatalf("enrichment must fill the name, got %q/%q", views[0].ActorName, views[0].ActorEmail)
	}
	if views[1].ActorName != "Admin Name" || views[1].ActorEmail != "admin" {
		t.Fatalf("enrichment must fill both name and login, got %q/%q", views[1].ActorName, views[1].ActorEmail)
	}
	if views[2].ActorName != "" || views[2].ActorEmail != "unknown@x.ru" {
		t.Fatalf("view without actor id must stay untouched, got %q/%q", views[2].ActorName, views[2].ActorEmail)
	}
}
