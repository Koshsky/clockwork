//nolint:testpackage // Reuses the session fake to verify lookup and rotation ordering.
package service

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/Koshsky/erp-backend/internal/auth/dto"
	"github.com/Koshsky/erp-backend/internal/security/hasher"
	userdomain "github.com/Koshsky/erp-backend/internal/user/domain"
)

type neutralUserLookup struct {
	user            *userdomain.Credentials
	failure         error
	username        string
	userID          int64
	credentialCalls int
	accountCalls    int
}

func (l *neutralUserLookup) FindUserByUsername(_ context.Context, username string) (*userdomain.Credentials, error) {
	l.username = username
	l.credentialCalls++
	return l.user, l.failure
}

func (l *neutralUserLookup) FindAccountByID(_ context.Context, id int64) (*userdomain.Account, error) {
	l.userID = id
	l.accountCalls++
	if l.failure != nil {
		return nil, l.failure
	}
	return &l.user.Account, nil
}

func neutralCredentials(hash string) *userdomain.Credentials {
	return &userdomain.Credentials{ID: testUserID, Username: "worker", Name: "Иванов Иван Иванович",
		LastName: "Иванов", FirstName: "Иван", MiddleName: new("Иванович"), Preset: new("vp"), PasswordHash: hash}
}

func TestLoginUsesNeutralCredentials(t *testing.T) {
	t.Parallel()
	hash, err := hasher.Hash("CorrectPass9!")
	if err != nil {
		t.Fatal(err)
	}
	for _, nullable := range []bool{false, true} {
		t.Run(map[bool]string{false: "complete profile", true: "null profile fields"}[nullable], func(t *testing.T) {
			t.Parallel()
			lookup := &neutralUserLookup{user: neutralCredentials(hash)}
			if nullable {
				lookup.user.MiddleName, lookup.user.Preset = nil, nil
				lookup.user.Name = "Иванов Иван"
			}
			store := newFakeSessionStore()
			svc := newTestAuthService(store)
			svc.users = lookup
			result, loginErr := svc.Login(t.Context(), "  WoRkEr  ", "CorrectPass9!")
			if loginErr != nil {
				t.Fatal(loginErr)
			}
			want := dto.UserInfo{ID: testUserID, Username: "worker", Name: lookup.user.Name,
				LastName: "Иванов", FirstName: "Иван", MiddleName: lookup.user.MiddleName, Preset: lookup.user.Preset}
			if !reflect.DeepEqual(result.Auth.User, want) || lookup.username != "worker" ||
				lookup.credentialCalls != 1 || lookup.accountCalls != 0 {
				t.Fatalf("login changed identity or normalization: %+v", result.Auth.User)
			}
			assertNeutralLoginSession(t, svc, store, result, hash)
		})
	}
}

func assertNeutralLoginSession(t *testing.T, svc *AuthService, store *fakeSessionStore,
	result *dto.SessionResult, hash string,
) {
	t.Helper()
	claims, err := svc.jwt.ValidateAccessToken(result.Auth.AccessToken)
	if err != nil || claims.UserID != testUserID || claims.Email != "worker" {
		t.Fatalf("invalid access identity: %+v, %v", claims, err)
	}
	if len(store.created) != 1 || store.created[0].UserID != testUserID ||
		store.created[0].TokenHash != hashToken(result.RefreshToken) || store.created[0].ReplacedBy != 0 {
		t.Fatal("login did not create a fresh hashed refresh session")
	}
	raw, err := json.Marshal(result.Auth)
	if err != nil || strings.Contains(string(raw), hash) || strings.Contains(string(raw), "password") ||
		result.Auth.RefreshToken != "" {
		t.Fatal("login body leaked a credential")
	}
}

func TestNeutralCredentialFailuresDoNotIssueSessions(t *testing.T) {
	t.Parallel()
	hash, err := hasher.Hash("CorrectPass9!")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, hash, password string
		failure              error
	}{
		{"wrong password", hash, "WrongPass9!", nil},
		{"invalid hash", "invalid-hash", "CorrectPass9!", nil},
		{"unknown user", hash, "CorrectPass9!", errors.New("not found")},
		{"cancelled lookup", hash, "CorrectPass9!", context.Canceled},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			lookup := &neutralUserLookup{user: neutralCredentials(tc.hash), failure: tc.failure}
			store := newFakeSessionStore()
			svc := newTestAuthService(store)
			svc.users = lookup
			result, loginErr := svc.Login(t.Context(), "worker", tc.password)
			if result != nil || loginErr == nil || loginErr.Error() != "invalid credentials" ||
				len(store.created) != 0 {
				t.Fatalf("failed login issued a session or exposed lookup details: %+v, %v", result, loginErr)
			}
		})
	}
}

func TestRefreshUsesPasswordlessAccount(t *testing.T) {
	t.Parallel()
	for _, failure := range []error{nil, errors.New("deleted user"), context.Canceled} {
		name := "fresh account"
		if failure != nil {
			name = failure.Error()
		}
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			lookup := &neutralUserLookup{user: neutralCredentials("unused-hash"), failure: failure}
			lookup.user.Preset = nil
			lookup.user.Name = "Updated Name"
			store := newFakeSessionStore()
			old := store.addSession(hashToken("old-token"), pgtype.Timestamptz{}, 0)
			svc := newTestAuthService(store)
			svc.users = lookup
			result, err := svc.RefreshToken(t.Context(), "old-token")
			if lookup.credentialCalls != 0 || lookup.accountCalls != 1 || lookup.userID != testUserID {
				t.Fatal("refresh used the credential lookup instead of the passwordless account")
			}
			if failure != nil {
				if result != nil || err == nil || err.Error() != "user not found" || len(store.created) != 0 ||
					store.byHash[hashToken("old-token")].RevokedAt.Valid {
					t.Fatalf("failed account lookup changed the existing session: %+v, %v", result, err)
				}
				return
			}
			if err != nil || result.Auth.User.Name != "Updated Name" || result.Auth.User.Preset != nil ||
				len(store.created) != 1 || store.created[0].ReplacedBy != old.ID ||
				!store.byHash[hashToken("old-token")].RevokedAt.Valid {
				t.Fatalf("account refresh failed to preserve identity and rotation: %+v, %v", result, err)
			}
		})
	}
}
