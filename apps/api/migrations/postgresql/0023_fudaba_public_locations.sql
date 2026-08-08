-- ims:migration-phase: post-data

CREATE TABLE public.fudaba_office_public_locations (
    office_id TEXT PRIMARY KEY
        REFERENCES public.fudaba_offices(id) ON DELETE CASCADE,
    latitude_e1 INTEGER NOT NULL CHECK (latitude_e1 BETWEEN -600 AND 600),
    longitude_e1 INTEGER NOT NULL CHECK (longitude_e1 BETWEEN -1800 AND 1800),
    review_state TEXT NOT NULL DEFAULT 'pending' CHECK (
        review_state IN ('pending', 'published', 'rejected')
    ),
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    submitted_at TIMESTAMPTZ NOT NULL,
    reviewed_at TIMESTAMPTZ,
    reviewed_by BIGINT
        REFERENCES public.backoffice_accounts(id) ON DELETE RESTRICT,
    review_audit_id UUID UNIQUE,
    review_note TEXT NOT NULL DEFAULT '' CHECK (length(review_note) <= 1000),
    CHECK (reviewed_at IS NULL OR reviewed_at >= submitted_at),
    CHECK (
        (
            review_state = 'pending'
            AND reviewed_at IS NULL
            AND reviewed_by IS NULL
            AND review_audit_id IS NULL
            AND review_note = ''
        ) OR (
            review_state IN ('published', 'rejected')
            AND reviewed_at IS NOT NULL
            AND reviewed_by IS NOT NULL
            AND review_audit_id IS NOT NULL
            AND (
                review_state <> 'rejected'
                OR length(btrim(review_note, E' \t\n\v\f\r')) BETWEEN 1 AND 1000
            )
        )
    )
);

CREATE INDEX fudaba_office_public_locations_public_idx
    ON public.fudaba_office_public_locations(
        latitude_e1, longitude_e1, office_id
    ) WHERE review_state = 'published';
CREATE INDEX fudaba_office_public_locations_review_queue_idx
    ON public.fudaba_office_public_locations(
        review_state, submitted_at, office_id
    );
CREATE INDEX fudaba_office_public_locations_reviewer_idx
    ON public.fudaba_office_public_locations(
        reviewed_by, reviewed_at DESC, office_id
    ) WHERE reviewed_by IS NOT NULL;

CREATE TABLE public.fudaba_rate_limit_windows (
    bucket TEXT NOT NULL CHECK (
        length(bucket) BETWEEN 1 AND 128
        AND length(btrim(bucket, E' \t\n\v\f\r')) = length(bucket)
    ),
    key_hash TEXT NOT NULL CHECK (key_hash ~ '^[0-9a-f]{64}$'),
    hits INTEGER NOT NULL CHECK (hits > 0),
    window_seconds INTEGER NOT NULL CHECK (window_seconds > 0),
    reset_at BIGINT NOT NULL CHECK (reset_at > 0),
    PRIMARY KEY (bucket, key_hash)
);

CREATE INDEX fudaba_rate_limit_windows_reset_at_idx
    ON public.fudaba_rate_limit_windows(reset_at);
