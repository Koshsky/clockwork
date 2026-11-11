package delivery

import (
	"github.com/gin-gonic/gin"

	"github.com/Koshsky/erp-backend/internal/response"
	"github.com/Koshsky/erp-backend/internal/user/dto"
)

// ListAccounts separates account visibility from employee-timesheet ownership.
//
// @Summary List account directory
// @Tags Users
// @Security ApiKeyAuth
// @Produce json
// @Param limit query int false "Page size (default 50, max 500)"
// @Param preset query string false "Role filter"
// @Param manager_id query int false "Manager filter"
// @Param include_hash query bool false "Include hashes (administrator only)"
// @Param search query string false "Name or login filter"
// @Param offset query int false "Page offset"
// @Success 200 {object} response.SuccessResponse{data=response.Page{items=[]dto.AdminUserResponse},error=nil}
// @Router /user/accounts [get]
func (h *UserHandler) ListAccounts(c *gin.Context) {
	h.listUsers(c, true)
}

// FindAccount uses the same authorization boundary as the account directory.
//
// @Summary Get account profile
// @Tags Users
// @Security ApiKeyAuth
// @Produce json
// @Param id path int true "User ID"
// @Success 200 {object} response.SuccessResponse{data=dto.UserResponse,error=nil}
// @Router /user/accounts/{id} [get]
func (h *UserHandler) FindAccount(c *gin.Context) {
	h.FindUser(c)
}

// ListStructure excludes credentials and account metadata from the company chart.
//
// @Summary List company structure
// @Tags Users
// @Security ApiKeyAuth
// @Produce json
// @Success 200 {object} response.SuccessResponse{data=[]dto.StructureUserResponse,error=nil}
// @Router /user/structure [get]
func (h *UserHandler) ListStructure(c *gin.Context) {
	users, err := h.service.ListAllUsers(c.Request.Context())
	if err != nil {
		response.Error(c, h.logger, err)
		return
	}
	rows := make([]dto.StructureUserResponse, 0, len(users))
	for _, user := range users {
		rows = append(rows, dto.StructureUserResponse{
			ID: user.ID, Name: user.Name, LastName: user.LastName,
			FirstName: user.FirstName, MiddleName: user.MiddleName,
			ManagerID: user.ManagerID, Position: user.Position, Preset: user.Preset,
		})
	}
	response.OK(c, rows)
}
