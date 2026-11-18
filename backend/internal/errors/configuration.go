package errors

// SetupError classifies bootstrap failures without retaining configuration values.
type SetupError string

func (e SetupError) Error() string { return string(e) }

const (
	ErrConfiguration    SetupError = "invalid configuration"
	ErrCommandArguments SetupError = "invalid command arguments"
)
