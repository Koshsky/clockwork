package service_test

import (
	"errors"
	"log/slog"
	"net/http"
	"reflect"
	"testing"

	"github.com/Koshsky/erp-backend/internal/authz/dto"
	"github.com/Koshsky/erp-backend/internal/authz/engine"
	"github.com/Koshsky/erp-backend/internal/authz/service"
	errapi "github.com/Koshsky/erp-backend/pkg/errors"
)

type rejectingRouteCatalog struct {
	service.RouteCatalog

	seen engine.RouteSpec
}

func (c *rejectingRouteCatalog) ValidateSpec(spec engine.RouteSpec) error {
	c.seen = spec
	return errors.New("invalid HTTP rule parameters")
}

func TestRouteCatalogValidationPrecedesRepositoryWrites(t *testing.T) {
	t.Parallel()
	catalog := &rejectingRouteCatalog{}
	app := service.NewRBACService(slog.New(slog.DiscardHandler), nil, nil, catalog)
	input := dto.RoutePolicyInput{Name: "task.view", Kind: "entity", Params: map[string]any{"resource": "task"}}
	err := app.UpsertRoutePolicy(t.Context(), input, 42)
	if err == nil || errapi.StatusCode(err) != http.StatusBadRequest {
		t.Fatalf("catalog validation must fail before repository access: %v", err)
	}
	want := engine.RouteSpec{Name: input.Name, Kind: input.Kind, Params: input.Params}
	if !reflect.DeepEqual(catalog.seen, want) {
		t.Fatalf("catalog received changed facts: %+v", catalog.seen)
	}
}
