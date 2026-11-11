-include ../.env
export

# Dev stack: infra (db + jaeger + loki + grafana + redis) in docker,
# API served locally by air. TRACING_ENDPOINT / REDIS_ADDRESS / AUDIT_URL
# point air at the in-docker Jaeger collector, Redis and Loki via their
# published ports (the docker-service names "jaeger"/"redis"/"loki" are not
# resolvable from the host; config.yaml keeps the in-network names for the
# all-in-docker run). Loki is published on 3100 so air reaches it at
# localhost:3100.
.PHONY: dev infra reset stop lint

dev:
	docker compose -f ../compose.yaml up -d db jaeger loki redis
	DATABASE_URL=postgres://$(DATABASE_USER):$(DATABASE_PASSWORD)@localhost:5432/$(DATABASE_NAME)?sslmode=disable \
	TRACING_ENDPOINT=localhost:4317 \
	REDIS_ADDRESS=localhost:6379 \
	AUDIT_URL=http://localhost:3100 \
	air

# Lint with the checked-in golangci-lint: needs golangci-lint >= 2.13.2
# (built with Go >= 1.27) to type-check the Go 1.27 stdlib and the module's
# go 1.27 language version. Install: go install
# github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.13.2
lint:
	golangci-lint run

reset:
	docker compose -f ../compose.yaml down -v
	docker compose -f ../compose.yaml up -d db jaeger loki redis

stop:
	docker compose -f ../compose.yaml down
