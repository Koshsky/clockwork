package main

import (
	"log"

	"github.com/gin-gonic/gin"
	swaggerFiles "github.com/swaggo/files"
	ginSwagger "github.com/swaggo/gin-swagger"

	_ "github.com/Koshsky/erp-backend/docs/swagger"
)

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
	router := gin.Default()
	router.GET("/swagger/*any", ginSwagger.WrapHandler(swaggerFiles.Handler))
	err := router.Run(":8080")
	if err != nil {
		log.Fatal(err)
	}
}
