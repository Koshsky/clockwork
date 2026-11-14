package idempotency

import (
	"bytes"
	"encoding/json"
	"io"
	"slices"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
)

const (
	revisionProcess  = "process"
	revisionStates   = "states"
	revisionProject  = "project"
	revisionResource = "resource"
	revisionUserDays = "user_days"
)

func validRevisionKey(key string) bool {
	if key == revisionStates {
		return true
	}
	kind, raw, ok := strings.Cut(key, ":")
	if !ok || !slices.Contains([]string{revisionProject, revisionProcess, revisionResource, revisionUserDays}, kind) {
		return false
	}
	id, err := strconv.ParseInt(raw, 10, 64)
	return err == nil && id > 0 && raw == strconv.FormatInt(id, 10)
}

func revisionUnique(keys []string) []string {
	slices.Sort(keys)
	return slices.Compact(keys)
}

func revisionID(value any) int64 {
	number, ok := value.(json.Number)
	if !ok {
		return 0
	}
	id, _ := number.Int64()
	if id < 0 {
		return 0
	}
	return id
}

func revisionAdd(keys *[]string, kind string, id int64) {
	if id > 0 {
		*keys = append(*keys, kind+":"+strconv.FormatInt(id, 10))
	}
}

func revisionPathKind(c *gin.Context) string {
	parts := strings.Split(strings.TrimPrefix(c.FullPath(), "/api/v1/"), "/")
	switch parts[0] {
	case revisionProject, revisionProcess, "task", "milestone", "assignment":
		return parts[0]
	case "resources":
		return revisionResource
	case "timesheet":
		if len(parts) > 1 && parts[1] == revisionStates {
			return revisionStates
		}
	case "user":
		if strings.HasSuffix(c.FullPath(), "/days") {
			return revisionUserDays
		}
	}
	return ""
}

func revisionReadKind(c *gin.Context) string {
	switch strings.TrimPrefix(c.FullPath(), "/api/v1") {
	case "/planning/projects":
		return revisionProject
	case "/planning/processes":
		return revisionProject
	case "/planning/tasks":
		return revisionProcess
	case "/timesheet/calendar":
		return "calendar"
	case "/resources/:id/members", "/resources/:id/absence":
		return "member"
	default:
		return revisionPathKind(c)
	}
}

func (m *Middleware) revisionWriteKeys(c *gin.Context) ([]string, error) {
	body, err := io.ReadAll(c.Request.Body)
	if err != nil {
		return nil, err
	}
	c.Request.Body = io.NopCloser(bytes.NewReader(body))
	values := map[string]any{}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	_ = decoder.Decode(&values)
	kind := revisionPathKind(c)
	if kind == revisionStates {
		return []string{revisionStates}, nil
	}
	id, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	keys := []string{}
	if id > 0 {
		found, findErr := m.revisions.RevisionParents(c.Request.Context(), kind, id)
		if findErr != nil {
			return nil, findErr
		}
		keys = append(keys, found...)
	}
	bodyKeys, err := m.revisionBodyKeys(c, kind, id, values)
	if err != nil {
		return nil, err
	}
	keys = append(keys, bodyKeys...)
	for _, field := range []string{"task_id", "parent_id", "depends_on_task_id"} {
		if taskID := revisionID(values[field]); taskID > 0 {
			found, findErr := m.revisions.RevisionParents(c.Request.Context(), "task", taskID)
			if findErr != nil {
				return nil, findErr
			}
			keys = append(keys, found...)
		}
	}
	if kind == revisionUserDays {
		keys = append(keys, revisionStates)
	}
	return revisionUnique(keys), nil
}

func (m *Middleware) revisionSnapshotKeys(c *gin.Context, raw json.RawMessage) ([]string, error) {
	var snapshot any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&snapshot); err != nil {
		return nil, err
	}
	keys := []string{}
	kind := revisionReadKind(c)
	if kind == revisionStates {
		return []string{revisionStates}, nil
	}
	id, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	if id > 0 {
		found, err := m.revisions.RevisionParents(c.Request.Context(), revisionPathKind(c), id)
		if err != nil {
			return nil, err
		}
		keys = append(keys, found...)
	}
	if kind == revisionUserDays {
		keys = append(keys, revisionStates)
	}
	if err := m.walkRevisionSnapshot(c, kind, snapshot, &keys); err != nil {
		return nil, err
	}
	return revisionUnique(keys), nil
}

func (m *Middleware) walkRevisionSnapshot(c *gin.Context, kind string, node any, keys *[]string) error {
	switch value := node.(type) {
	case []any:
		for _, child := range value {
			if err := m.walkRevisionSnapshot(c, kind, child, keys); err != nil {
				return err
			}
		}
	case map[string]any:
		if err := m.revisionObjectKeys(c, kind, value, keys); err != nil {
			return err
		}
		for field, child := range value {
			childKind := revisionChildKind(field, kind)
			if childKind != "" {
				if err := m.walkRevisionSnapshot(c, childKind, child, keys); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func revisionChildKind(field, kind string) string {
	switch field {
	case "projects":
		return revisionProject
	case "processes":
		return revisionProcess
	case "tasks", "subtasks":
		return "task"
	case "milestones":
		return "milestone"
	case "resources":
		return revisionResource
	case "dependencies":
		return "dependency"
	case "items":
		return kind
	default:
		return ""
	}
}

func (m *Middleware) revisionObjectKeys(c *gin.Context, kind string, value map[string]any, keys *[]string) error {
	switch kind {
	case revisionProject, revisionProcess, revisionResource:
		revisionAdd(keys, kind, revisionID(value["id"]))
	case revisionUserDays:
		revisionAdd(keys, kind, revisionID(value["user_id"]))
	}
	revisionAdd(keys, revisionProject, revisionID(value["project_id"]))
	revisionAdd(keys, revisionProcess, revisionID(value["process_id"]))
	revisionAdd(keys, revisionResource, revisionID(value["resource_id"]))
	if taskID := revisionID(value["task_id"]); taskID > 0 {
		found, err := m.revisions.RevisionParents(c.Request.Context(), "task", taskID)
		if err != nil {
			return err
		}
		*keys = append(*keys, found...)
	}
	return nil
}

func (m *Middleware) revisionBodyKeys(c *gin.Context, kind string, id int64, values map[string]any) ([]string, error) {
	keys := []string{}
	for field, parent := range map[string]string{"project_id": revisionProject, "process_id": revisionProcess, "resource_id": revisionResource} {
		parentID := revisionID(values[field])
		if kind == revisionProcess && id > 0 && field == "project_id" {
			current, findErr := m.revisions.RevisionParents(c.Request.Context(), "process_parent", id)
			if findErr != nil {
				return nil, findErr
			}
			if slices.Contains(current, "project:"+strconv.FormatInt(parentID, 10)) {
				continue
			}
		}
		revisionAdd(&keys, parent, parentID)
	}
	return keys, nil
}
