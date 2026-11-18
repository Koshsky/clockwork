package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	apperrors "github.com/Koshsky/erp-backend/internal/errors"
	"github.com/Koshsky/erp-backend/internal/logger"
	"github.com/Koshsky/erp-backend/internal/migration"
)

func migrationCommand(args []string) error {
	if err := validateMigrationArguments(args); err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, migrationCommandTimeout)
	defer cancel()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		return fmt.Errorf("DATABASE_URL is required")
	}
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return fmt.Errorf("connect migration database: %w", err)
	}
	defer pool.Close()
	var report any
	switch args[0] {
	case "status":
		report, err = migration.Status(ctx, pool)
	case "up":
		err = migration.Run(ctx, pool, logger.Bootstrap(version, os.Stderr))
		if err == nil {
			report, err = migration.Status(ctx, pool)
		}
	case adoptFlywayCommand:
		report, err = migration.AdoptFlyway(ctx, pool, len(args) == adoptionPreviewArguments)
	default:
		return fmt.Errorf(
			"%w: usage: service migrate {status|up|adopt-flyway [--dry-run]}",
			apperrors.ErrCommandArguments,
		)
	}
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(report)
}

const migrationCommandTimeout = 5 * time.Minute
const adoptionPreviewArguments = 2

func validateMigrationArguments(args []string) error {
	if len(args) == 1 {
		switch args[0] {
		case "status", "up", adoptFlywayCommand:
			return nil
		}
	}
	if len(args) == adoptionPreviewArguments && args[0] == adoptFlywayCommand && args[1] == "--dry-run" {
		return nil
	}
	return fmt.Errorf("%w: usage: service migrate {status|up|adopt-flyway [--dry-run]}", apperrors.ErrCommandArguments)
}

const adoptFlywayCommand = "adopt-flyway"
