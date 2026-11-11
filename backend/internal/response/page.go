package response

import (
	"strconv"

	"github.com/gin-gonic/gin"

	"github.com/Koshsky/erp-backend/pkg/errors"
)

const (
	// DefaultLimit is the page size used when limit is not provided.
	DefaultLimit = 50
	// MaxLimit caps the page size.
	MaxLimit = 500
)

// Page wraps a paginated listing payload { items, total, limit, offset }.
// Items is typed in swagger via the response annotation override
// (response.Page{items=[]dto.X}); the runtime value is the item slice.
type Page struct {
	Items  any   `json:"items"`
	Total  int64 `json:"total"`
	Limit  int   `json:"limit"`
	Offset int   `json:"offset"`
}

// QueryID returns the query param as int64, or 0 when missing or invalid
// (the RBAC list policy has already validated the format).
func QueryID(c *gin.Context, key string) int64 {
	raw := c.Query(key)
	if raw == "" {
		return 0
	}
	v, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || v < 0 {
		return 0
	}
	return v
}

// ParsePagination reads limit/offset query params with sane defaults:
// limit defaults to DefaultLimit and is capped at MaxLimit; offset defaults to 0.
func ParsePagination(c *gin.Context) (int, int, error) {
	limit := DefaultLimit
	if raw := c.Query("limit"); raw != "" {
		v, perr := strconv.Atoi(raw)
		if perr != nil || v < 1 {
			return 0, 0, errors.BadRequest("invalid limit")
		}
		if v > MaxLimit {
			v = MaxLimit
		}
		limit = v
	}
	offset := 0
	if raw := c.Query("offset"); raw != "" {
		v, perr := strconv.Atoi(raw)
		if perr != nil || v < 0 {
			return 0, 0, errors.BadRequest("invalid offset")
		}
		offset = v
	}
	return limit, offset, nil
}
