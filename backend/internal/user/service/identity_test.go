package service_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"reflect"
	"strings"
	"testing"

	"github.com/Koshsky/erp-backend/internal/tracing"
	"github.com/Koshsky/erp-backend/internal/user/domain"
	"github.com/Koshsky/erp-backend/internal/user/repository/sqlc"
	"github.com/Koshsky/erp-backend/internal/user/service"
	errorsapi "github.com/Koshsky/erp-backend/pkg/errors"
)

type identityRepository struct {
	service.UserRepository

	row      *sqlc.User
	rows     []sqlc.User
	failure  error
	username string
	id       int64
}

func (r *identityRepository) FindUserByUsername(_ context.Context, username string) (*sqlc.User, error) {
	r.username = username
	return r.row, r.failure
}

func (r *identityRepository) FindUser(_ context.Context, id int64) (*sqlc.User, error) {
	r.id = id
	return r.row, r.failure
}

func (r *identityRepository) ListAllUsers(context.Context) ([]sqlc.User, error) {
	return r.rows, r.failure
}

func identityService(repo *identityRepository) *service.UserService {
	return service.NewUserService(slog.New(slog.DiscardHandler), tracing.New(nil), repo, nil, nil, nil)
}

func assertNoUserHash(t *testing.T, value any, hash string) {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), hash) || strings.Contains(strings.ToLower(string(raw)), "password") {
		t.Fatal("password hash escaped the credential boundary")
	}
}

func TestUserIdentityLookupsPreserveOptionalFields(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, last, first, full string
		middle, preset          sql.NullString
		wantMiddle, wantPreset  *string
	}{
		{"full name", "Иванов", "Иван", "Иванов Иван Иванович",
			sql.NullString{String: "Иванович", Valid: true}, sql.NullString{String: "vp", Valid: true}, new("Иванович"), new("vp")},
		{"null fields", "Иванов", "Иван", "Иванов Иван",
			sql.NullString{String: "ignored"}, sql.NullString{String: "ignored"}, nil, nil},
		{"empty valid fields", "Иванов", "", "Иванов",
			sql.NullString{Valid: true}, sql.NullString{Valid: true}, nil, nil},
		{"middle name only", "", "", "Иванович",
			sql.NullString{String: "Иванович", Valid: true}, sql.NullString{}, new("Иванович"), nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			row := &sqlc.User{ID: 7, Username: "worker", LastName: tc.last, FirstName: tc.first,
				MiddleName: tc.middle, Preset: tc.preset, PasswordHash: "secret-credential-hash"}
			repo := &identityRepository{row: row}
			svc := identityService(repo)
			want := domain.Account{ID: 7, Username: "worker", Name: tc.full,
				LastName: tc.last, FirstName: tc.first, MiddleName: tc.wantMiddle, Preset: tc.wantPreset}
			credentials, err := svc.FindUserByUsername(t.Context(), "Worker")
			if err != nil || credentials == nil || !reflect.DeepEqual(credentials.Account, want) ||
				credentials.PasswordHash != row.PasswordHash || repo.username != "Worker" {
				t.Fatalf("credential lookup lost account fields: %+v, %v", credentials, err)
			}
			account, err := svc.FindAccountByID(t.Context(), 7)
			if err != nil || !reflect.DeepEqual(account, &want) || repo.id != 7 {
				t.Fatalf("account lookup lost fields: %+v, %v", account, err)
			}
			response, err := svc.FindUser(t.Context(), 7)
			if err != nil || response.Name != tc.full || !reflect.DeepEqual(response.Preset, tc.wantPreset) {
				t.Fatalf("public user lookup changed: %+v, %v", response, err)
			}
			for _, value := range []any{credentials, account, response} {
				assertNoUserHash(t, value, row.PasswordHash)
			}
		})
	}
}

func TestUserIdentityLookupFailures(t *testing.T) {
	t.Parallel()
	for _, failure := range []error{errors.New("database unavailable"), context.Canceled} {
		t.Run(failure.Error(), func(t *testing.T) {
			t.Parallel()
			svc := identityService(&identityRepository{failure: failure})
			credentials, err := svc.FindUserByUsername(t.Context(), "missing")
			if credentials != nil || !errors.Is(err, failure) {
				t.Fatalf("credential lookup swallowed error: %+v, %v", credentials, err)
			}
			account, err := svc.FindAccountByID(t.Context(), 7)
			if account != nil || !errors.Is(err, failure) {
				t.Fatalf("account lookup swallowed error: %+v, %v", account, err)
			}
			identities, err := svc.ListUserIdentities(t.Context())
			if identities != nil || !errors.Is(err, failure) {
				t.Fatalf("identity lookup swallowed error: %+v, %v", identities, err)
			}
		})
	}
}

func TestUserIdentityMissingAccount(t *testing.T) {
	t.Parallel()
	svc := identityService(&identityRepository{})
	credentials, err := svc.FindUserByUsername(t.Context(), "missing")
	if credentials != nil || !errorsapi.IsNotFoundError(err) {
		t.Fatalf("nil credential row was not rejected: %+v, %v", credentials, err)
	}
	account, err := svc.FindAccountByID(t.Context(), 7)
	if account != nil || !errorsapi.IsNotFoundError(err) {
		t.Fatalf("nil account row was not rejected: %+v, %v", account, err)
	}
}

func TestUserIdentityListPreservesEmptyAndOrder(t *testing.T) {
	t.Parallel()
	for _, rows := range [][]sqlc.User{nil, {}, {
		{ID: 9, Username: "second", LastName: "Two", PasswordHash: "secret-hash"},
		{ID: 3, Username: "first", FirstName: "One", PasswordHash: "secret-hash"},
	}} {
		repo := &identityRepository{rows: rows}
		identities, err := identityService(repo).ListUserIdentities(t.Context())
		if err != nil || identities == nil || len(identities) != len(rows) {
			t.Fatalf("list changed empty/order contract: %+v, %v", identities, err)
		}
		for i, row := range rows {
			if identities[i].ID != row.ID || identities[i].Username != row.Username {
				t.Fatal("identity listing changed repository order")
			}
		}
		assertNoUserHash(t, identities, "secret-hash")
	}
}
