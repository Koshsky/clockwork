package comment_test

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	comment "github.com/Koshsky/erp-backend/internal/project_mgmt/comment"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/comment/dto"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/comment/repository/sqlc"
	"github.com/Koshsky/erp-backend/internal/tracing"
	errorsapi "github.com/Koshsky/erp-backend/pkg/errors"
)

type commentRepository struct {
	parent             *sqlc.TaskComment
	created            *sqlc.TaskComment
	rows               []sqlc.TaskComment
	foundErr, writeErr error
	listErr            error
	reads, writes      int
	listedTask         int64
}

func commentFixture() sqlc.TaskComment {
	return sqlc.TaskComment{ID: 3, TaskID: 11, AuthorID: 7, Content: "Content",
		CreatedAt: time.Date(2026, time.November, 15, 12, 0, 0, 0, time.UTC)}
}

func newCommentService(repo *commentRepository) *comment.Service {
	return comment.NewService(slog.New(slog.DiscardHandler), tracing.New(nil), repo)
}

func (r *commentRepository) CreateComment(_ context.Context, taskID, authorID int64, parentID *int64,
	content string,
) (*sqlc.TaskComment, error) {
	r.writes++
	row := commentFixture()
	row.ID = 4
	row.TaskID, row.AuthorID, row.Content = taskID, authorID, content
	if parentID != nil {
		row.ParentID = pgtype.Int8{Int64: *parentID, Valid: true}
	}
	r.created = &row
	return r.created, r.writeErr
}

func (r *commentRepository) FindComment(context.Context, int64) (*sqlc.TaskComment, error) {
	r.reads++
	return r.parent, r.foundErr
}

func (r *commentRepository) DeleteComment(context.Context, int64) error {
	r.writes++
	return r.writeErr
}

func (r *commentRepository) ListComments(_ context.Context, taskID int64) ([]sqlc.TaskComment, error) {
	r.listedTask = taskID
	return r.rows, r.listErr
}

func TestCommentTextRoundTrip(t *testing.T) {
	t.Parallel()
	for _, content := range []string{
		"  Привет 👩🏽‍💻\n\n**жирный** и `код`  ",
		`<img src=x onerror="alert(1)"><script>alert(2)</script>`,
		`[link](javascript:alert(1)) &lt;svg onload=alert(1)&gt;`,
		strings.Repeat("я", 4000),
	} {
		repo := &commentRepository{}
		created, err := newCommentService(
			repo,
		).CreateComment(t.Context(), 11, dto.CreateCommentRequest{Content: content}, 7)
		if err != nil || repo.reads != 0 || repo.writes != 1 || repo.created.Content != content ||
			created.Content != content || created.AuthorID != 7 || created.TaskID != 11 || created.ParentID != nil {
			t.Fatalf("comment content or identity changed: %v", err)
		}
		raw, err := json.Marshal(created)
		if err != nil {
			t.Fatal(err)
		}
		var decoded dto.CommentResponse
		if err = json.Unmarshal(raw, &decoded); err != nil || decoded.Content != content {
			t.Fatalf("JSON round trip transformed content: %v", err)
		}
	}
}

func TestCommentReplyValidation(t *testing.T) {
	t.Parallel()
	failure := errors.New("database unavailable")
	for _, tc := range []struct {
		name, message string
		parent        *sqlc.TaskComment
		failure       error
	}{
		{"same task", "", new(commentFixture()), nil},
		{"foreign task", "parent comment belongs to another task", &sqlc.TaskComment{ID: 3, TaskID: 22}, nil},
		{"missing parent", "parent comment not found", nil, errorsapi.ErrNotFound},
		{"nil parent", "parent comment not found", nil, nil},
		{"database failure", "database unavailable", nil, failure},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			repo := &commentRepository{parent: tc.parent, foundErr: tc.failure}
			created, err := newCommentService(repo).CreateComment(t.Context(), 11,
				dto.CreateCommentRequest{Content: "Reply", ParentID: new(int64(3))}, 7)
			if tc.message == "" {
				if err != nil || created.ParentID == nil || *created.ParentID != 3 || repo.writes != 1 {
					t.Fatalf("valid reply rejected: %+v, %v", created, err)
				}
				return
			}
			if err == nil || err.Error() != tc.message || repo.writes != 0 || created != nil {
				t.Fatalf("invalid reply reached a write: %+v, %v", repo, err)
			}
			if errors.Is(tc.failure, failure) && !errors.Is(err, failure) {
				t.Fatal("parent lookup swallowed the database failure")
			}
		})
	}
}

func TestCommentInvalidInputDoesNotReadOrWrite(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, field, content string
		task, author         int64
	}{
		{"negative task", "task_id", "Text", -1, 7},
		{"negative author", "author_id", "Text", 11, -1},
		{"blank content", "content", "\n\t", 11, 7},
		{"unicode over limit", "content", strings.Repeat("я", 4001), 11, 7},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			repo := &commentRepository{}
			_, err := newCommentService(repo).CreateComment(t.Context(), tc.task,
				dto.CreateCommentRequest{Content: tc.content, ParentID: new(int64(3))}, tc.author)
			var field *errorsapi.FieldError
			if !errors.As(err, &field) || field.Field != tc.field || repo.reads != 0 || repo.writes != 0 {
				t.Fatalf("validation ordering changed: %+v, %v", repo, err)
			}
		})
	}
}

func TestCommentListAndMapping(t *testing.T) {
	t.Parallel()
	mapper := comment.NewMapper()
	if mapper.ToDTO(nil) != nil || mapper.ToDTOs(nil) == nil || len(mapper.ToDTOs(nil)) != 0 {
		t.Fatal("nil/empty comment mapping changed")
	}
	first, reply := commentFixture(), commentFixture()
	first.ID, reply.ID = 9, 2
	reply.ParentID = pgtype.Int8{Int64: 9, Valid: true}
	reply.Content = "Reply"
	repo := &commentRepository{rows: []sqlc.TaskComment{first, reply}}
	items, err := newCommentService(repo).ListComments(t.Context(), 11)
	if err != nil || repo.listedTask != 11 || len(items) != 2 || items[0].ID != 9 || items[1].ID != 2 ||
		items[0].ParentID != nil || items[1].ParentID == nil || *items[1].ParentID != 9 ||
		!items[0].CreatedAt.Equal(first.CreatedAt) || items[1].Content != "Reply" {
		t.Fatalf("flat thread mapping/order changed: %+v, %v", items, err)
	}
	want := dto.CommentResponse{ID: 9, TaskID: 11, AuthorID: 7, Content: "Content", CreatedAt: first.CreatedAt}
	if !reflect.DeepEqual(items[0], want) {
		t.Fatalf("root comment mapping changed: %+v", items[0])
	}
}

func TestCommentRepositoryFailuresAndIdempotentDelete(t *testing.T) {
	t.Parallel()
	failure := errors.New("database unavailable")
	for _, tc := range []struct {
		name string
		repo commentRepository
		want error
	}{
		{"existing", commentRepository{parent: new(commentFixture())}, nil},
		{"missing", commentRepository{foundErr: errorsapi.ErrNotFound}, nil},
		{"nil", commentRepository{}, nil},
		{"read failure", commentRepository{foundErr: failure}, failure},
		{"write failure", commentRepository{parent: new(commentFixture()), writeErr: failure}, failure},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			err := newCommentService(&tc.repo).DeleteComment(t.Context(), 3)
			if !errors.Is(err, tc.want) || (tc.repo.parent == nil && tc.repo.writes != 0) {
				t.Fatalf("delete error/idempotency changed: %+v, %v", tc.repo, err)
			}
		})
	}
	createRepo := &commentRepository{writeErr: failure}
	if _, err := newCommentService(
		createRepo,
	).CreateComment(t.Context(), 11, dto.CreateCommentRequest{Content: "Text"}, 7); !errors.Is(
		err,
		failure,
	) {
		t.Fatalf("create error swallowed: %v", err)
	}
	if items, err := newCommentService(
		&commentRepository{listErr: failure},
	).ListComments(t.Context(), 11); !errors.Is(err, failure) ||
		items != nil {
		t.Fatalf("list error swallowed: %+v, %v", items, err)
	}
}
