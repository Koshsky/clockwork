package delivery_test

import (
	"context"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgtype"

	access "github.com/Koshsky/erp-backend/internal/authz/domain"
	"github.com/Koshsky/erp-backend/internal/authz/engine"
	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	comment "github.com/Koshsky/erp-backend/internal/project_mgmt/comment"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/comment/delivery"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/comment/repository/sqlc"
	"github.com/Koshsky/erp-backend/internal/tracing"
	"github.com/Koshsky/erp-backend/internal/userctx"
	"github.com/Koshsky/erp-backend/pkg/errors"
)

type discussionRepository struct {
	created       *sqlc.TaskComment
	reads, writes int
}

func discussionComment(id int64) (*sqlc.TaskComment, error) {
	row := sqlc.TaskComment{ID: id, TaskID: 11, AuthorID: 8, Content: "Stored text"}
	switch id {
	case 1:
		row.AuthorID = 7
	case 2:
		row.TaskID = 22
	case 3:
	case 4:
		row.TaskID = 99
	default:
		return nil, errors.ErrNotFound
	}
	return &row, nil
}

func discussionTask(_ context.Context, id int64) (access.Owners, error) {
	switch id {
	case 11:
		return access.Owners{ProcessOwner: 7, ProjectOwner: 9}, nil
	case 22:
		return access.Owners{ProcessOwner: 8, ProjectOwner: 9}, nil
	default:
		return access.Owners{}, errors.ErrNotFound
	}
}

func (r *discussionRepository) CreateComment(_ context.Context, task, author int64, parent *int64,
	content string,
) (*sqlc.TaskComment, error) {
	r.writes++
	row := sqlc.TaskComment{ID: 5, TaskID: task, AuthorID: author, Content: content}
	if parent != nil {
		row.ParentID = pgtype.Int8{Int64: *parent, Valid: true}
	}
	r.created = &row
	return r.created, nil
}

func (r *discussionRepository) FindComment(_ context.Context, id int64) (*sqlc.TaskComment, error) {
	r.reads++
	return discussionComment(id)
}

func (r *discussionRepository) ListComments(_ context.Context, task int64) ([]sqlc.TaskComment, error) {
	r.reads++
	return []sqlc.TaskComment{{ID: 1, TaskID: task, AuthorID: 7, Content: "Stored text"}}, nil
}

func (r *discussionRepository) DeleteComment(context.Context, int64) error { r.writes++; return nil }

func discussionRouter(user access.UserContext, repo *discussionRepository) *gin.Engine {
	mw := rbac.ProvideMiddleware(nil, tracing.New(nil), rbac.Data{
		TaskOwners: discussionTask,
		CommentOwners: func(ctx context.Context, id int64) (access.Owners, error) {
			row, err := discussionComment(id)
			if err != nil {
				return access.Owners{}, err
			}
			owners, err := discussionTask(ctx, row.TaskID)
			owners.Owner = row.AuthorID
			return owners, err
		},
	}, rbac.ProvideAll())
	svc := comment.NewService(slog.New(slog.DiscardHandler), tracing.New(nil), repo)
	handler := delivery.NewCommentHandler(slog.New(slog.DiscardHandler), svc, mw)
	_, router := gin.CreateTestContext(httptest.NewRecorder())
	router.Use(func(c *gin.Context) { c.Set(userctx.KeyUser, user) })
	handler.RegisterRoutes(router.Group("/api/v1"))
	return router
}

//nolint:paralleltest // Publishes the shared task authorization snapshot.
func TestCommentHTTPAccessAndAuthorBinding(t *testing.T) {
	t.Cleanup(func() {
		if err := engine.Publish(engine.DefaultPublishInput()); err != nil {
			t.Fatal(err)
		}
	})
	if err := engine.Publish(engine.PublishInput{Grants: []engine.RuleGrant{
		{Sub: "discussion-owner", Key: "task/view", Scope: "process_owner"},
		{Sub: "discussion-owner", Key: "task/update", Scope: "process_owner"},
		{Sub: "discussion-viewer", Key: "task/view", Scope: "process_owner"},
	}}); err != nil {
		t.Fatal(err)
	}
	viewer := access.UserContext{ID: 7, Preset: "discussion-viewer"}
	owner := access.UserContext{ID: 7, Preset: "discussion-owner"}
	admin := access.UserContext{ID: 7, Admin: true}
	for _, tc := range []struct {
		name, method, path, body string
		user                     access.UserContext
		status, writes           int
	}{
		{"visible discussion", "GET", "11/comments", "", viewer, 200, 0},
		{"hidden discussion", "GET", "22/comments", "", viewer, 404, 0},
		{"visible create", "POST", "11/comments", `{"content":"Text"}`, viewer, 201, 1},
		{"hidden create", "POST", "22/comments", `{"content":"Text"}`, viewer, 404, 0},
		{"deleted task list", "GET", "99/comments", "", admin, 404, 0},
		{"deleted task create", "POST", "99/comments", `{"content":"Text"}`, admin, 404, 0},
		{"author delete", "DELETE", "11/comments/1", "", access.UserContext{ID: 7}, 204, 1},
		{"viewer cannot delete foreign", "DELETE", "11/comments/3", "", viewer, 403, 0},
		{"owner delete", "DELETE", "11/comments/3", "", owner, 204, 1},
		{"foreign comment on visible path", "DELETE", "11/comments/2", "", owner, 403, 0},
		{"admin delete", "DELETE", "22/comments/2", "", admin, 204, 1},
		{"missing comment", "DELETE", "11/comments/999", "", admin, 404, 0},
		{"deleted task delete", "DELETE", "99/comments/4", "", admin, 404, 0},
		{"foreign parent", "POST", "11/comments", `{"content":"Reply","parent_id":2}`, viewer, 400, 0},
		{"missing parent", "POST", "11/comments", `{"content":"Reply","parent_id":999}`, viewer, 400, 0},
		{"valid reply", "POST", "11/comments", `{"content":"Reply","parent_id":1}`, viewer, 201, 1},
		{"spoofed author and task", "POST", "11/comments", `{"content":"<img src=x onerror=alert(1)>","author_id":999,"task_id":22}`, viewer, 201, 1},
		{"invalid task id", "GET", "bad/comments", "", admin, 400, 0},
		{"invalid comment id", "DELETE", "11/comments/bad", "", admin, 400, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repo := &discussionRepository{}
			request := httptest.NewRequest(tc.method, "/api/v1/task/"+tc.path, strings.NewReader(tc.body))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			discussionRouter(tc.user, repo).ServeHTTP(response, request)
			if response.Code != tc.status || repo.writes != tc.writes {
				t.Fatalf(
					"status=%d reads=%d writes=%d body=%s",
					response.Code,
					repo.reads,
					repo.writes,
					response.Body.String(),
				)
			}
			if (tc.status == 403 || tc.status == 404) && repo.reads != 0 {
				t.Fatal("hidden task/comment reached the core repository")
			}
			if repo.created != nil && (repo.created.TaskID != 11 || repo.created.AuthorID != tc.user.ID) {
				t.Fatal("caller changed the bound task or authenticated author")
			}
		})
	}
}
