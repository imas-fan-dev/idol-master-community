PRAGMA foreign_keys = ON;

ALTER TABLE platform_email_verification_codes
    ADD COLUMN pending_token TEXT CHECK (
        pending_token IS NULL OR (
            length(pending_token) = 64
            AND pending_token = lower(pending_token)
            AND pending_token NOT GLOB '*[^a-f0-9]*'
        )
    );
ALTER TABLE platform_email_verification_codes
    ADD COLUMN pending_code_hash TEXT CHECK (
        pending_code_hash IS NULL OR (
            length(pending_code_hash) = 64
            AND pending_code_hash = lower(pending_code_hash)
            AND pending_code_hash NOT GLOB '*[^a-f0-9]*'
        )
    );
ALTER TABLE platform_email_verification_codes
    ADD COLUMN pending_expires_at INTEGER CHECK (
        pending_expires_at IS NULL OR pending_expires_at >= 0
    );
ALTER TABLE platform_email_verification_codes
    ADD COLUMN pending_resend_after INTEGER CHECK (
        pending_resend_after IS NULL OR pending_resend_after >= 0
    );
ALTER TABLE platform_email_verification_codes
    ADD COLUMN pending_attempts_remaining INTEGER CHECK (
        pending_attempts_remaining IS NULL OR
        pending_attempts_remaining BETWEEN 0 AND 5
    );
ALTER TABLE platform_email_verification_codes
    ADD COLUMN pending_created_at INTEGER CHECK (
        (
            pending_created_at IS NULL
            AND pending_token IS NULL
            AND pending_code_hash IS NULL
            AND pending_expires_at IS NULL
            AND pending_resend_after IS NULL
            AND pending_attempts_remaining IS NULL
        ) OR (
            pending_created_at >= 0
            AND pending_token IS NOT NULL
            AND pending_code_hash IS NOT NULL
            AND pending_expires_at > pending_created_at
            AND pending_resend_after BETWEEN pending_created_at AND pending_expires_at
            AND pending_attempts_remaining IS NOT NULL
        )
    );
ALTER TABLE platform_email_verification_codes
    ADD COLUMN delivery_token TEXT CHECK (
        delivery_token IS NULL OR (
            length(delivery_token) = 64
            AND delivery_token = lower(delivery_token)
            AND delivery_token NOT GLOB '*[^a-f0-9]*'
            AND pending_token IS NULL
        )
    );
