-- Successful operations outlive temporary transport keys and account sessions.
CREATE TABLE operation_receipts (
    user_id BIGINT NOT NULL,
    operation_id TEXT NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    response_status INTEGER NOT NULL,
    response_body JSONB,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, operation_id)
);
