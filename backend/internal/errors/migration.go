// Package errors defines sentinel errors for infrastructure startup failures.
package errors

// MigrationError keeps validation failures distinguishable from database errors.
type MigrationError string

func (e MigrationError) Error() string {
	return string(e)
}

const (
	ErrMigrationValidation MigrationError = "migration validation failed"
	ErrMigrationExecution  MigrationError = "migration execution failed"
)
