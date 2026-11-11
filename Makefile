-include .env
export
AIR ?= air

.PHONY: infra backend frontend check check-backend check-frontend
infra:
	docker compose up -d db loki jaeger redis
backend:
	cd backend && $(AIR) -c air.toml
frontend:
	cd frontend && npm start
check: check-layout check-backend check-frontend
check-layout:
	python3 scripts/check-repository.py
check-backend:
	cd backend && go build ./... && go vet ./... && go test ./...
check-frontend:
	cd frontend && npm run check && npm run lint && npm run test:stories -- --project unit
