FROM --platform=$BUILDPLATFORM golang:1.27-alpine AS builder

WORKDIR /src

# Semantic version of the release (SemVer tag, e.g. v1.0.0); baked into the
# binary via main.version (see cmd/service/main.go). Default "dev" for ad-hoc
# builds; scripts/deploy.sh always passes the release tag.
ARG APP_VERSION=dev

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags "-X main.version=${APP_VERSION}" -o /out/service ./cmd/service

FROM alpine:3.21

WORKDIR /app

RUN adduser -D -u 10001 appuser

# Core SQL is embedded in the service; deployment-specific seeds are excluded.
COPY --from=builder /out/service /app/service
COPY --from=builder /src/docs /app/docs

EXPOSE 8080

USER appuser

ENTRYPOINT ["/app/service"]
