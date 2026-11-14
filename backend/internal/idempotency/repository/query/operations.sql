-- name: TryOperationLock :one
SELECT pg_try_advisory_xact_lock(
    hashtextextended('operation_receipts'::regclass::oid::text || ':' || @identity::text, 0)
)::boolean;

-- name: FindOperationReceipt :one
SELECT user_id, operation_id, method, path, request_hash, response_status, response_body, completed_at
FROM operation_receipts
WHERE user_id = @user_id::bigint AND operation_id = @operation_id;

-- name: CompleteOperation :exec
INSERT INTO operation_receipts (user_id, operation_id, method, path, request_hash, response_status, response_body)
VALUES (@user_id::bigint, @operation_id, @method, @path, @request_hash, @response_status::integer, @response_body::jsonb);
