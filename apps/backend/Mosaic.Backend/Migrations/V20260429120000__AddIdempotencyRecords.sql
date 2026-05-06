CREATE TABLE IF NOT EXISTS idempotency_records (
    user_id uuid NOT NULL,
    idempotency_key character varying(255) NOT NULL,
    request_hash bytea NOT NULL,
    response_status integer NOT NULL,
    response_body_hash bytea NOT NULL,
    response_body bytea NOT NULL,
    response_headers_subset text NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT pk_idempotency_records PRIMARY KEY (user_id, idempotency_key),
    CONSTRAINT fk_idempotency_records_users_user_id
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ix_idempotency_records_created_at
    ON idempotency_records (created_at);
