-- ims:migration-phase: post-data

ALTER TABLE public.platform_email_verification_codes
    ADD COLUMN pending_token TEXT,
    ADD COLUMN pending_code_hash TEXT,
    ADD COLUMN pending_expires_at BIGINT,
    ADD COLUMN pending_resend_after BIGINT,
    ADD COLUMN pending_attempts_remaining INTEGER,
    ADD COLUMN pending_created_at BIGINT,
    ADD COLUMN delivery_token TEXT,
    ADD CONSTRAINT platform_email_verification_delivery_token_ck CHECK (
        delivery_token IS NULL OR (
            delivery_token ~ '^[a-f0-9]{64}$'
            AND pending_token IS NULL
        )
    ),
    ADD CONSTRAINT platform_email_verification_pending_candidate_ck CHECK (
        (
            pending_token IS NULL
            AND pending_code_hash IS NULL
            AND pending_expires_at IS NULL
            AND pending_resend_after IS NULL
            AND pending_attempts_remaining IS NULL
            AND pending_created_at IS NULL
        ) OR (
            pending_token ~ '^[a-f0-9]{64}$'
            AND pending_code_hash ~ '^[a-f0-9]{64}$'
            AND pending_expires_at > pending_created_at
            AND pending_resend_after BETWEEN pending_created_at AND pending_expires_at
            AND pending_attempts_remaining BETWEEN 0 AND 5
            AND pending_created_at >= 0
            AND delivery_token IS NULL
        )
    );
