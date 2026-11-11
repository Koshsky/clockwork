package migration

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	apperrors "github.com/Koshsky/erp-backend/internal/errors"
	"github.com/Koshsky/erp-backend/migrations"
)

type Adoption struct {
	Baseline       int  `json:"baseline"`
	DryRun         bool `json:"dry_run"`
	AlreadyAdopted bool `json:"already_adopted"`
}

// AdoptFlyway transfers a validated core prefix without executing SQL or changing Flyway history.
func AdoptFlyway(ctx context.Context, pool *pgxpool.Pool, dryRun bool) (_ *Adoption, result error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() {
		const rollbackTimeout = 5 * time.Second
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), rollbackTimeout)
		defer cancel()
		rollbackErr := tx.Rollback(cleanupCtx)
		if !errors.Is(rollbackErr, pgx.ErrTxClosed) {
			result = errors.Join(result, rollbackErr)
		}
	}()
	table, err := prepareHistory(ctx, tx)
	if err != nil {
		return nil, err
	}
	scripts, err := loadScripts([]fs.FS{migrations.Files()})
	if err != nil {
		return nil, err
	}
	applied, err := appliedVersions(ctx, tx, table, scripts)
	if err != nil {
		return nil, err
	}
	baseline, err := coreBaseline(scripts, applied)
	if err != nil {
		return nil, err
	}
	state, err := readStatus(ctx, tx)
	if err != nil {
		return nil, err
	}
	conflicting := state.Version >= 0 && state.Version < baseline
	if state.Dirty || state.Version > int(scripts[len(scripts)-1].version) || conflicting {
		return nil, fmt.Errorf("%w: native history is dirty or conflicts with Flyway", apperrors.ErrMigrationValidation)
	}
	report := &Adoption{Baseline: baseline, DryRun: dryRun, AlreadyAdopted: state.Version >= baseline}
	if !dryRun && !report.AlreadyAdopted {
		runner, engineErr := engine(pool)
		if engineErr != nil {
			return nil, engineErr
		}
		forceErr := runner.Force(baseline)
		if err = errors.Join(forceErr, closeEngine(runner)); err != nil {
			return nil, fmt.Errorf("adopt Flyway: %w", err)
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return report, nil
}

func coreBaseline(scripts []script, applied map[string]bool) (int, error) {
	baseline := 0
	missing := false
	for _, item := range scripts {
		if !applied[strconv.FormatInt(item.version, 10)] {
			missing = true
			continue
		}
		if missing || item.version != int64(baseline+1) {
			return 0, fmt.Errorf("%w: core history has gaps", apperrors.ErrMigrationValidation)
		}
		baseline = int(item.version)
	}
	if baseline == 0 {
		return 0, fmt.Errorf("%w: no recognized core history", apperrors.ErrMigrationValidation)
	}

	return baseline, nil
}
