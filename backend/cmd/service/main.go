package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Koshsky/erp-backend/internal/server"

	_ "github.com/Koshsky/erp-backend/docs/swagger"
)

const defaultShutdownTimeout = 5 * time.Second

// version is the semantic version of the service (SemVer tag on main, e.g.
// v1.0.0); injected at build time via -ldflags "-X main.version=…" (see the
// Dockerfile). Local builds (make dev / air) fall back to "dev".

var version = "dev"

//	@title			Enterprise Resource Planning
//	@version		1.4.3
//	@description	For managing the enterprise's universal resources
//	@termsOfService	http://swagger.io/terms/

//	@contact.name	Shmonov Matvey
//	@contact.url	https://t.me/Koshsky
//	@contact.email	shmonov.mv@gmail.com

//	@license.name	Apache 2.0
//	@license.url	http://www.apache.org/licenses/LICENSE-2.0.html

// Note (AD-14): host is a placeholder until a domain appears; aligned with
// the dev deployment (http, localhost:8080) — swagger is disabled in prod
// (M6) and only served by the dev-only cmd/swagger/main.go on :8080.
//	@host		localhost:8080
//	@schemes	http
//	@BasePath	/api/v1

//	@securityDefinitions.apikey	ApiKeyAuth
//	@in							header
//	@name						Authorization
//	@description				"Provide JWT token in the format: Bearer {token}"

//	@externalDocs.description	ERP documentation (placeholder)
//	@externalDocs.url			https://swagger.io/resources/open-api/

func main() {
	if len(os.Args) > 1 && os.Args[1] == "migrate" {
		if err := migrationCommand(os.Args[2:]); err != nil {
			log.Fatal(err)
		}
		return
	}

	// build the application dependency graph
	application, err := server.InitializeApp()
	if err != nil {
		log.Fatal(err)
	}
	application.Logger().Info("service configuration loaded", "version", version)

	// create a context that is canceled on SIGINT or SIGTERM
	runCtx, _ := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)

	// start HTTP server
	if err = application.Start(); err != nil {
		application.Logger().Error("failed to start server", "error", err)
		os.Exit(1)
	}

	// graceful shutdown
	<-runCtx.Done()
	application.Logger().Info("shutdown signal received")

	// stop server with 5 second timeout
	shutdownCtx, cancel := context.WithTimeout(context.Background(), defaultShutdownTimeout)
	defer cancel()

	if err = application.Stop(shutdownCtx); err != nil {
		application.Logger().Error("error during graceful shutdown", "error", err)
	}

	application.Logger().Info("service stopped")
}
