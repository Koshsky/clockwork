package tracing

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"time"

	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"

	errinternal "github.com/Koshsky/erp-backend/internal/errors"
)

const (
	maxTokenLength   = 4096
	retryInterval    = 200 * time.Millisecond
	maxRetryInterval = time.Second
)

func newExporter(cfg Config) (sdktrace.SpanExporter, func(), error) {
	if err := validateExporter(cfg); err != nil {
		return nil, nil, err
	}
	creds, err := exporterCredentials(cfg)
	if err != nil {
		return nil, nil, err
	}
	// An owned connection prevents OTEL endpoint, insecure, TLS and client-key
	// environment variables from changing the explicitly approved destination.
	conn, err := grpc.NewClient(cfg.ExporterEndpoint, grpc.WithTransportCredentials(creds))
	if err != nil {
		return nil, nil, fmt.Errorf("create trace connection: %w", errinternal.ErrConfiguration)
	}
	headers := map[string]string{}
	if cfg.AuthToken != "" {
		headers["authorization"] = "Bearer " + cfg.AuthToken
	}
	exp, err := otlptracegrpc.New(context.Background(),
		otlptracegrpc.WithGRPCConn(conn), otlptracegrpc.WithHeaders(headers),
		otlptracegrpc.WithTimeout(exportTimeout),
		otlptracegrpc.WithRetry(otlptracegrpc.RetryConfig{
			Enabled: true, InitialInterval: retryInterval, MaxInterval: maxRetryInterval, MaxElapsedTime: exportTimeout,
		}),
	)
	if err != nil {
		_ = conn.Close()
		return nil, nil, fmt.Errorf("create trace exporter: %w", errinternal.ErrConfiguration)
	}
	return exp, func() { _ = conn.Close() }, nil
}

func validateExporter(cfg Config) error {
	host, port, err := net.SplitHostPort(cfg.ExporterEndpoint)
	number, parseErr := strconv.ParseUint(port, 10, 16)
	invalidHost := strings.ContainsAny(host, "/@?#%\\") ||
		strings.IndexFunc(host, func(r rune) bool { return r <= ' ' || r > '~' }) >= 0
	if err != nil || parseErr != nil || host == "" || number == 0 || invalidHost {
		return fmt.Errorf("tracing exporter_endpoint must be host:port: %w", errinternal.ErrConfiguration)
	}
	if cfg.Insecure && (cfg.AuthToken != "" || cfg.CAFile != "") {
		return fmt.Errorf("tracing credentials require TLS: %w", errinternal.ErrConfiguration)
	}
	if len(cfg.AuthToken) > maxTokenLength || strings.IndexFunc(cfg.AuthToken, func(r rune) bool {
		return r < '!' || r > '~'
	}) >= 0 {
		return fmt.Errorf("invalid tracing auth token: %w", errinternal.ErrConfiguration)
	}
	return nil
}

func exporterCredentials(cfg Config) (credentials.TransportCredentials, error) {
	if cfg.Insecure {
		return insecure.NewCredentials(), nil
	}
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12}
	if cfg.CAFile != "" {
		pem, err := os.ReadFile(cfg.CAFile)
		if err != nil {
			return nil, fmt.Errorf("read tracing CA: %w", errinternal.ErrConfiguration)
		}
		roots, err := x509.SystemCertPool()
		if err != nil {
			roots = x509.NewCertPool()
		}
		if !roots.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("invalid tracing CA: %w", errinternal.ErrConfiguration)
		}
		tlsConfig.RootCAs = roots
	}
	return credentials.NewTLS(tlsConfig), nil
}
