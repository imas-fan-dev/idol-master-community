PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS platform_email_verification_codes (
    normalized_email TEXT PRIMARY KEY CHECK (
        length(normalized_email) BETWEEN 3 AND 320
        AND normalized_email = lower(trim(normalized_email))
    ),
    code_hash TEXT NOT NULL CHECK (
        length(code_hash) = 64
        AND code_hash = lower(code_hash)
        AND code_hash NOT GLOB '*[^a-f0-9]*'
    ),
    expires_at INTEGER NOT NULL CHECK (expires_at >= 0),
    resend_after INTEGER NOT NULL CHECK (resend_after >= 0),
    attempts_remaining INTEGER NOT NULL CHECK (
        attempts_remaining BETWEEN 0 AND 5
    ),
    consumed_token TEXT CHECK (
        consumed_token IS NULL OR (
            length(consumed_token) = 64
            AND consumed_token = lower(consumed_token)
            AND consumed_token NOT GLOB '*[^a-f0-9]*'
        )
    ),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    CHECK (expires_at > created_at),
    CHECK (resend_after >= created_at AND resend_after <= expires_at)
);

CREATE INDEX IF NOT EXISTS idx_platform_email_verification_expiry
    ON platform_email_verification_codes(expires_at);
