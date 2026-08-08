-- ims:migration-phase: post-data

CREATE TABLE public.platform_email_verification_codes (
    normalized_email TEXT PRIMARY KEY CHECK (
        length(normalized_email) BETWEEN 3 AND 320
        AND normalized_email = lower(btrim(normalized_email))
    ),
    code_hash TEXT NOT NULL CHECK (code_hash ~ '^[a-f0-9]{64}$'),
    expires_at BIGINT NOT NULL CHECK (expires_at >= 0),
    resend_after BIGINT NOT NULL CHECK (resend_after >= 0),
    attempts_remaining INTEGER NOT NULL CHECK (
        attempts_remaining BETWEEN 0 AND 5
    ),
    consumed_token TEXT CHECK (
        consumed_token IS NULL OR consumed_token ~ '^[a-f0-9]{64}$'
    ),
    created_at BIGINT NOT NULL CHECK (created_at >= 0),
    updated_at BIGINT NOT NULL CHECK (updated_at >= created_at),
    CHECK (expires_at > created_at),
    CHECK (resend_after >= created_at AND resend_after <= expires_at)
);

CREATE INDEX platform_email_verification_expiry_idx
    ON public.platform_email_verification_codes(expires_at);
