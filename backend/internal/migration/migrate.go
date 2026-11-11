package migration

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"time"

	migrate "github.com/golang-migrate/migrate/v4"
	pgxmigrate "github.com/golang-migrate/migrate/v4/database/pgx/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"

	apperrors "github.com/Koshsky/erp-backend/internal/errors"
	"github.com/Koshsky/erp-backend/migrations"
)

type State struct {
	Version int  `json:"version"`
	Dirty   bool `json:"dirty"`
	Flyway  bool `json:"flyway"`
}

func Status(ctx context.Context, pool *pgxpool.Pool) (*State, error) {
	return readStatus(ctx, pool)
}

type statusReader interface {
	QueryRow(context.Context, string, ...any) pgx.Row
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

func readStatus(ctx context.Context, reader statusReader) (*State, error) {
	state := &State{Version: -1}
	var native bool
	err := reader.QueryRow(ctx, `SELECT to_regclass(format('%I.flyway_schema_history', current_schema())) IS NOT NULL,
 to_regclass(format('%I.schema_migrations', current_schema())) IS NOT NULL`).Scan(&state.Flyway, &native)
	if err != nil {
		return nil, fmt.Errorf("inspect migration tables: %w", err)
	}
	if native {
		rows, queryErr := reader.Query(ctx, "SELECT version, dirty FROM schema_migrations")
		if queryErr != nil {
			return nil, queryErr
		}
		defer rows.Close()
		count := 0
		for rows.Next() {
			count++
			if err = rows.Scan(&state.Version, &state.Dirty); err != nil {
				return nil, err
			}
		}
		if err = rows.Err(); err != nil {
			return nil, err
		}
		if count > 1 {
			return nil, fmt.Errorf("%w: multiple native versions", apperrors.ErrMigrationValidation)
		}
	}
	return state, nil
}

func engine(pool *pgxpool.Pool) (*migrate.Migrate, error) {
	scripts, err := loadScripts([]fs.FS{migrations.Files()})
	if err != nil {
		return nil, err
	}
	return engineWithScripts(pool, scripts)
}

func engineWithScripts(pool *pgxpool.Pool, scripts []script) (*migrate.Migrate, error) {
	source, err := newSource(scripts)
	if err != nil {
		return nil, err
	}
	connection := pool.Config().ConnConfig.Copy()
	const connectionTimeout = 15 * time.Second
	connection.ConnectTimeout = connectionTimeout
	connection.RuntimeParams["lock_timeout"] = "15s"
	connection.RuntimeParams["statement_timeout"] = "5min"
	db := stdlib.OpenDB(*connection)
	const statementTimeout = 5 * time.Minute
	driver, err := pgxmigrate.WithInstance(db, &pgxmigrate.Config{StatementTimeout: statementTimeout})
	if err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("initialize golang-migrate: %w", err)
	}
	runner, err := migrate.NewWithInstance("embedded", source, "pgx5", driver)
	if err != nil {
		_ = driver.Close()
		return nil, err
	}
	return runner, nil
}

func closeEngine(runner *migrate.Migrate) error {
	sourceErr, databaseErr := runner.Close()
	return errors.Join(sourceErr, databaseErr)
}

func Run(ctx context.Context, pool *pgxpool.Pool, logger *slog.Logger) (result error) {
	state, err := Status(ctx, pool)
	if err != nil {
		return err
	}
	if state.Flyway && state.Version < 0 {
		return fmt.Errorf("%w: run service migrate adopt-flyway before startup", apperrors.ErrMigrationValidation)
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	runner, err := engine(pool)
	if err != nil {
		return err
	}
	defer func() { result = errors.Join(result, closeEngine(runner)) }()
	stop := context.AfterFunc(ctx, func() { runner.GracefulStop <- true })
	defer stop()
	if err = runner.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return fmt.Errorf("%w: %w", apperrors.ErrMigrationExecution, err)
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	logger.InfoContext(ctx, "golang-migrate schema ready")
	return nil
}
