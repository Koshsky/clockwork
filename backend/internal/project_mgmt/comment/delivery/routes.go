package delivery

import (
	"github.com/gin-gonic/gin"
)

// RegisterRoutes registers the nested comment routes within the
// existing /task subgroup (task visibility is enforced by policies).
func (h *CommentHandler) RegisterRoutes(router *gin.RouterGroup) {
	r := router.Group("/task")
	{
		r.GET("/:id/comments", h.mw.Check("task.comment.list"), h.ListComments)
		r.POST("/:id/comments", h.mw.Check("task.comment.create"), h.CreateComment)
		r.DELETE("/:id/comments/:comment_id", h.mw.Check("task.comment.delete"), h.DeleteComment)
	}
}
