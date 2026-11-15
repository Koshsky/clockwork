// Package timesheet wires the timesheet module's providers and routes.
package timesheet

import (
	"github.com/gin-gonic/gin"
	"github.com/google/wire"

	calendarDelivery "github.com/Koshsky/erp-backend/internal/timesheet/calendar/delivery"
	calendarRepo "github.com/Koshsky/erp-backend/internal/timesheet/calendar/repository"
	calendarService "github.com/Koshsky/erp-backend/internal/timesheet/calendar/service"
	resourceService "github.com/Koshsky/erp-backend/internal/timesheet/resource"
	resourceDelivery "github.com/Koshsky/erp-backend/internal/timesheet/resource/delivery"
	resourceRepo "github.com/Koshsky/erp-backend/internal/timesheet/resource/repository"
	stateService "github.com/Koshsky/erp-backend/internal/timesheet/state"
	stateDelivery "github.com/Koshsky/erp-backend/internal/timesheet/state/delivery"
	stateRepo "github.com/Koshsky/erp-backend/internal/timesheet/state/repository"
)

// ProviderSet aggregates the timesheet module's dependencies.
//
//nolint:gochecknoglobals // wire provider set (established module pattern)
var ProviderSet = wire.NewSet(
	resourceRepo.NewResourceRepository,
	wire.Bind(new(resourceService.Repository), new(*resourceRepo.ResourceRepository)),
	resourceService.NewService,
	resourceDelivery.NewResourceHandler,

	stateRepo.NewStateRepository,
	wire.Bind(new(stateService.Repository), new(*stateRepo.StateRepository)),
	stateService.NewService,
	stateDelivery.NewStateHandler,

	calendarRepo.NewCalendarRepository,
	wire.Bind(new(calendarService.CalendarRepository), new(*calendarRepo.CalendarRepository)),
	calendarService.NewCalendarService,
	calendarDelivery.NewCalendarHandler,

	ProvideModule,
)

// Module registers the timesheet module's routes (all protected).
type Module struct {
	resource *resourceDelivery.ResourceHandler
	state    *stateDelivery.StateHandler
	calendar *calendarDelivery.CalendarHandler
}

// ProvideModule builds the timesheet module.
func ProvideModule(
	resource *resourceDelivery.ResourceHandler,
	state *stateDelivery.StateHandler,
	calendar *calendarDelivery.CalendarHandler,
) Module {
	return Module{
		resource: resource,
		state:    state,
		calendar: calendar,
	}
}

// RegisterPublicRoutes is a no-op: the module has no public routes.
func (m Module) RegisterPublicRoutes(_ *gin.RouterGroup) {
}

// RegisterProtectedRoutes registers the module's routes behind authentication.
func (m Module) RegisterProtectedRoutes(r *gin.RouterGroup) {
	m.resource.RegisterRoutes(r)
	m.state.RegisterRoutes(r)
	m.calendar.RegisterRoutes(r)
}
