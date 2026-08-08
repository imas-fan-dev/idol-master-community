PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS fudaba_office_public_locations (
    office_id TEXT PRIMARY KEY,
    latitude_e1 INTEGER NOT NULL CHECK (
        typeof(latitude_e1) = 'integer'
        AND latitude_e1 BETWEEN -600 AND 600
    ),
    longitude_e1 INTEGER NOT NULL CHECK (
        typeof(longitude_e1) = 'integer'
        AND longitude_e1 BETWEEN -1800 AND 1800
    ),
    review_state TEXT NOT NULL DEFAULT 'pending' CHECK (
        review_state IN ('pending', 'published', 'rejected')
    ),
    revision INTEGER NOT NULL DEFAULT 0 CHECK (
        typeof(revision) = 'integer'
        AND revision BETWEEN 0 AND 2147483647
    ),
    submitted_at TEXT NOT NULL CHECK (julianday(submitted_at) IS NOT NULL),
    reviewed_at TEXT CHECK (
        reviewed_at IS NULL OR julianday(reviewed_at) IS NOT NULL
    ),
    reviewed_by INTEGER,
    review_audit_id TEXT UNIQUE CHECK (
        review_audit_id IS NULL OR (
            length(review_audit_id) = 36
            AND review_audit_id = lower(review_audit_id)
            AND substr(review_audit_id, 9, 1) = '-'
            AND substr(review_audit_id, 14, 1) = '-'
            AND substr(review_audit_id, 19, 1) = '-'
            AND substr(review_audit_id, 24, 1) = '-'
            AND length(replace(review_audit_id, '-', '')) = 32
            AND replace(review_audit_id, '-', '') NOT GLOB '*[^0-9a-f]*'
        )
    ),
    review_note TEXT NOT NULL DEFAULT '' CHECK (length(review_note) <= 1000),
    CHECK (
        reviewed_at IS NULL
        OR julianday(reviewed_at) >= julianday(submitted_at)
    ),
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
                OR length(
                    trim(review_note, char(9, 10, 11, 12, 13, 32))
                ) BETWEEN 1 AND 1000
            )
        )
    ),
    FOREIGN KEY(office_id) REFERENCES fudaba_offices(id) ON DELETE CASCADE,
    FOREIGN KEY(reviewed_by) REFERENCES users(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_fudaba_office_public_locations_public
    ON fudaba_office_public_locations(latitude_e1, longitude_e1, office_id)
    WHERE review_state = 'published';
CREATE INDEX IF NOT EXISTS idx_fudaba_office_public_locations_review_queue
    ON fudaba_office_public_locations(review_state, submitted_at, office_id);
CREATE INDEX IF NOT EXISTS idx_fudaba_office_public_locations_reviewer
    ON fudaba_office_public_locations(reviewed_by, reviewed_at DESC, office_id)
    WHERE reviewed_by IS NOT NULL;

CREATE TABLE IF NOT EXISTS fudaba_rate_limit_windows (
    bucket TEXT NOT NULL CHECK (
        length(bucket) BETWEEN 1 AND 128
        AND length(trim(bucket, char(9, 10, 11, 12, 13, 32))) = length(bucket)
    ),
    key_hash TEXT NOT NULL CHECK (
        length(key_hash) = 64
        AND key_hash = lower(key_hash)
        AND key_hash NOT GLOB '*[^0-9a-f]*'
    ),
    hits INTEGER NOT NULL CHECK (
        typeof(hits) = 'integer'
        AND hits BETWEEN 1 AND 2147483647
    ),
    window_seconds INTEGER NOT NULL CHECK (
        typeof(window_seconds) = 'integer'
        AND window_seconds BETWEEN 1 AND 2147483647
    ),
    reset_at INTEGER NOT NULL CHECK (
        typeof(reset_at) = 'integer'
        AND reset_at > 0
    ),
    PRIMARY KEY (bucket, key_hash)
);

CREATE INDEX IF NOT EXISTS idx_fudaba_rate_limit_windows_reset_at
    ON fudaba_rate_limit_windows(reset_at);
