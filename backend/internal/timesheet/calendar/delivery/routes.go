package delivery

import (
	"github.com/gin-gonic/gin"
)

func (h *CalendarHandler) RegisterRoutes(router *gin.RouterGroup) {
	r := router.Group("/timesheet/calendar")
	{
		r.GET("", h.mw.Check("calendar.view"), h.GetCalendar)
	}
}
