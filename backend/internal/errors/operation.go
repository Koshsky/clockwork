package errors

// OperationError identifies invalid durable-operation state without exposing storage details.
type OperationError string

func (e OperationError) Error() string {
	return string(e)
}

const (
	ErrOperationTransactionRequired OperationError = "operation completion requires a request transaction"
	ErrOperationResponseInvalid     OperationError = "operation response must be successful"
	ErrRevisionTokenMissing         OperationError = "revision metadata is incomplete"
	ErrRevisionRequestInvalid       OperationError = "invalid revision preconditions"
)
