//nolint:testpackage // service-level tests construct UserService directly with a stub repository (unexported fields)
package service

import (
	"context"
	stderrors "errors"
	"strings"
	"testing"

	"github.com/Koshsky/erp-backend/internal/user/repository/sqlc"
	apperrors "github.com/Koshsky/erp-backend/pkg/errors"
)

// TestDeleteUserBlockedByReferences checks that DeleteUser fails with a 409
// listing the blocking records instead of deleting the user.
func TestDeleteUserBlockedByReferences(t *testing.T) {
	t.Parallel()
	repo := newStubRepo()
	repo.refs = sqlc.ListUserReferencesRow{
		Managees:  2,
		Projects:  1,
		Resources: 5,
	}
	svc := newStubService(repo)

	err := svc.DeleteUser(context.Background(), 7)
	if err == nil {
		t.Fatal("DeleteUser() succeeded, want a conflict error")
	}
	if !stderrors.Is(err, apperrors.ErrConflict) {
		t.Fatalf("DeleteUser() error = %v, want a Conflict error", err)
	}
	conf, ok := stderrors.AsType[*apperrors.DomainError](err)
	if !ok || conf.Message == "" {
		t.Fatalf("DeleteUser() error = %v, want a DomainError with a message", err)
	}
	for _, want := range []string{"подчинённые — 2", "проекты — 1", "ресурсы — 5"} {
		if !strings.Contains(conf.Message, want) {
			t.Errorf("conflict message %q does not mention %q", conf.Message, want)
		}
	}
}

// TestDeleteUserWithoutReferences checks that a user with no referencing
// records is deleted and sessions are revoked.
func TestDeleteUserWithoutReferences(t *testing.T) {
	t.Parallel()
	repo := newStubRepo()
	revoker := &stubSessionRevoker{}
	svc := newRevokeTestService(repo, revoker)

	if err := svc.DeleteUser(context.Background(), testUserID); err != nil {
		t.Fatalf("DeleteUser() error = %v", err)
	}
	if got := revoker.revokedIDs(); len(got) != 1 || got[0] != testUserID {
		t.Errorf("revoked sessions = %v, want [%d]", got, testUserID)
	}
}

// TestUserReferencesConflictMessage covers the message grouping: zero groups
// are omitted, only non-zero ones are listed.
func TestUserReferencesConflictMessage(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		refs sqlc.ListUserReferencesRow
		want string
	}{
		{
			name: "no references",
			refs: sqlc.ListUserReferencesRow{},
			want: "",
		},
		{
			name: "single group",
			refs: sqlc.ListUserReferencesRow{Comments: 3},
			want: "комментарии — 3",
		},
		{
			name: "all groups",
			refs: sqlc.ListUserReferencesRow{
				Managees: 1, Resources: 2, Projects: 3, Processes: 4,
				Tasks: 5, Comments: 6, AutoCreateTemplates: 1,
			},
			want: "подчинённые — 1, ресурсы — 2, проекты — 3, процессы — 4, задачи — 5, комментарии — 6, шаблоны автосоздания — 1",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := userReferencesConflict(tt.refs)
			if tt.want == "" {
				if got != "" {
					t.Errorf("userReferencesConflict() = %q, want empty", got)
				}
				return
			}
			if !strings.Contains(got, tt.want) {
				t.Errorf("userReferencesConflict() = %q, want it to contain %q", got, tt.want)
			}
		})
	}
}
