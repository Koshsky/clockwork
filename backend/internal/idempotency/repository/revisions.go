package repository

import (
	"context"
	"errors"
	"fmt"
	"strconv"

	"github.com/jackc/pgx/v5"
)

// BeginRevisionSnapshot keeps business data and its tokens in the same MVCC snapshot.
func (r *IdempotencyRepository) BeginRevisionSnapshot(ctx context.Context) (pgx.Tx, error) {
	return r.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
}

// LockRevisionWriters follows the V11 lock order shared by all covered legacy writers.
func (r *IdempotencyRepository) LockRevisionWriters(ctx context.Context) error {
	return r.q(ctx).LockRevisionWriters(ctx)
}

// RevisionTokens never lists an unrequested object's metadata.
func (r *IdempotencyRepository) RevisionTokens(ctx context.Context, keys []string) (map[string]string, error) {
	rows, err := r.q(ctx).ListOperationRevisions(ctx, keys)
	if err != nil {
		return nil, fmt.Errorf("read operation revisions: %w", err)
	}
	result := make(map[string]string, len(rows))
	for _, row := range rows {
		result[row.Key] = row.Revision
	}
	return result, nil
}

// RevisionParents resolves current aggregates inside the request transaction.
func (r *IdempotencyRepository) RevisionParents(ctx context.Context, kind string, id int64) ([]string, error) {
	q := r.q(ctx)
	switch kind {
	case "project", "process", "resource", "user_days":
		return []string{kind + ":" + strconv.FormatInt(id, 10)}, nil
	case "process_parent":
		parent, err := q.RevisionProcessProject(ctx, id)
		return revisionParentResult("project", parent, err)
	case "task":
		parent, err := q.RevisionTaskProcess(ctx, id)
		return revisionParentResult("process", parent, err)
	case "milestone":
		parent, err := q.RevisionMilestoneProcess(ctx, id)
		return revisionParentResult("process", parent, err)
	case "assignment":
		row, err := q.RevisionAssignmentParents(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		if err != nil {
			return nil, fmt.Errorf("find revision assignment: %w", err)
		}
		return []string{
			"process:" + strconv.FormatInt(row.ProcessID, 10),
			"resource:" + strconv.FormatInt(row.ResourceID, 10),
		}, nil
	default:
		return nil, nil
	}
}

func revisionParentResult(kind string, id int64, err error) ([]string, error) {
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("find revision parent: %w", err)
	}
	return []string{kind + ":" + strconv.FormatInt(id, 10)}, nil
}
