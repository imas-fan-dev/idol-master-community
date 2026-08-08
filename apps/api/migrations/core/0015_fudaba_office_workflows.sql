PRAGMA foreign_keys = ON;

BEGIN IMMEDIATE;

ALTER TABLE fudaba_offices
    ADD COLUMN pending_cover_object_key TEXT CHECK (
        pending_cover_object_key IS NULL
        OR length(pending_cover_object_key) BETWEEN 1 AND 1024
    );
ALTER TABLE fudaba_offices
    ADD COLUMN pending_cover_submitted_at TEXT CHECK (
        pending_cover_submitted_at IS NULL OR (
            julianday(pending_cover_submitted_at) IS NOT NULL
            AND julianday(pending_cover_submitted_at) >= julianday(created_at)
        )
    );

ALTER TABLE fudaba_office_cards
    ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK (
        typeof(revision) = 'integer'
        AND revision BETWEEN 0 AND 2147483647
    );
ALTER TABLE fudaba_office_cards ADD COLUMN updated_at TEXT;
UPDATE fudaba_office_cards SET updated_at = pinned_at WHERE updated_at IS NULL;

ALTER TABLE fudaba_messages
    ADD COLUMN hidden_by_account_id TEXT
        REFERENCES platform_accounts(id) ON DELETE RESTRICT;

CREATE TRIGGER fudaba_historical_hidden_message_actor_preflight
BEFORE UPDATE OF hidden_by_account_id ON fudaba_messages
WHEN (NEW.hidden_at IS NULL) <> (NEW.hidden_by_account_id IS NULL)
BEGIN
    SELECT RAISE(
        ROLLBACK,
        'FUDABA_HISTORICAL_HIDDEN_MESSAGE_REQUIRES_ACTOR'
    );
END;
UPDATE fudaba_messages
SET hidden_by_account_id = hidden_by_account_id
WHERE (hidden_at IS NULL) <> (hidden_by_account_id IS NULL);
DROP TRIGGER fudaba_historical_hidden_message_actor_preflight;

CREATE INDEX idx_fudaba_offices_pending_cover
    ON fudaba_offices(pending_cover_submitted_at, id)
    WHERE pending_cover_object_key IS NOT NULL;

DROP INDEX idx_fudaba_messages_office_time;
CREATE INDEX idx_fudaba_messages_office_time
    ON fudaba_messages(office_id, created_at DESC, id DESC)
    WHERE hidden_at IS NULL;
CREATE INDEX idx_fudaba_messages_hidden_by
    ON fudaba_messages(hidden_by_account_id, hidden_at DESC, id)
    WHERE hidden_by_account_id IS NOT NULL;

CREATE TABLE fudaba_geocoder_cache (
    provider TEXT NOT NULL CHECK (
        length(provider) BETWEEN 1 AND 64
        AND provider = lower(provider)
        AND provider NOT GLOB '*[^a-z0-9-]*'
        AND provider NOT GLOB '-*'
        AND provider NOT GLOB '*-'
        AND provider NOT GLOB '*--*'
    ),
    query_hash TEXT NOT NULL CHECK (
        length(query_hash) = 64
        AND query_hash = lower(query_hash)
        AND query_hash NOT GLOB '*[^0-9a-f]*'
    ),
    response_json TEXT NOT NULL CHECK (
        length(CAST(response_json AS BLOB)) BETWEEN 2 AND 65536
        AND CASE
            WHEN json_valid(response_json) = 1
            THEN json_type(response_json) IN ('object', 'array')
            ELSE 0
        END
    ),
    expires_at INTEGER NOT NULL CHECK (
        typeof(expires_at) = 'integer'
        AND expires_at BETWEEN 1 AND 9007199254740991
    ),
    updated_at INTEGER NOT NULL CHECK (
        typeof(updated_at) = 'integer'
        AND updated_at BETWEEN 0 AND 9007199254740991
    ),
    PRIMARY KEY (provider, query_hash),
    CHECK (expires_at > updated_at)
);

CREATE INDEX idx_fudaba_geocoder_cache_expires_at
    ON fudaba_geocoder_cache(expires_at);

CREATE TABLE fudaba_mutation_receipts (
    scope TEXT NOT NULL CHECK (
        length(scope) BETWEEN 1 AND 64
        AND scope = lower(scope)
        AND scope NOT GLOB '*[^a-z0-9-]*'
        AND scope NOT GLOB '-*'
        AND scope NOT GLOB '*-'
        AND scope NOT GLOB '*--*'
    ),
    account_id TEXT NOT NULL,
    key_hash TEXT NOT NULL CHECK (
        length(key_hash) = 64
        AND key_hash = lower(key_hash)
        AND key_hash NOT GLOB '*[^0-9a-f]*'
    ),
    request_hash TEXT NOT NULL CHECK (
        length(request_hash) = 64
        AND request_hash = lower(request_hash)
        AND request_hash NOT GLOB '*[^0-9a-f]*'
    ),
    resource_id TEXT NOT NULL CHECK (
        length(resource_id) BETWEEN 1 AND 128
        AND length(trim(resource_id, char(9, 10, 11, 12, 13, 32))) > 0
    ),
    created_at INTEGER NOT NULL CHECK (
        typeof(created_at) = 'integer'
        AND created_at BETWEEN 0 AND 9007199254740991
    ),
    PRIMARY KEY (scope, account_id, key_hash),
    FOREIGN KEY(account_id)
        REFERENCES platform_accounts(id) ON DELETE RESTRICT
);

CREATE INDEX idx_fudaba_mutation_receipts_created_at
    ON fudaba_mutation_receipts(created_at, scope, account_id);

CREATE TRIGGER fudaba_offices_pending_cover_insert_check
BEFORE INSERT ON fudaba_offices
WHEN (NEW.pending_cover_object_key IS NULL)
        <> (NEW.pending_cover_submitted_at IS NULL)
    OR (
        NEW.pending_cover_object_key IS NOT NULL
        AND (
            length(NEW.pending_cover_object_key) NOT BETWEEN 1 AND 1024
            OR NEW.pending_cover_object_key = NEW.cover_object_key
            OR julianday(NEW.pending_cover_submitted_at) IS NULL
            OR julianday(NEW.pending_cover_submitted_at) < julianday(NEW.created_at)
        )
    )
BEGIN
    SELECT RAISE(ABORT, 'FUDABA_PENDING_COVER_INVALID');
END;

CREATE TRIGGER fudaba_offices_pending_cover_update_check
BEFORE UPDATE OF cover_object_key, pending_cover_object_key,
    pending_cover_submitted_at, created_at ON fudaba_offices
WHEN (NEW.pending_cover_object_key IS NULL)
        <> (NEW.pending_cover_submitted_at IS NULL)
    OR (
        NEW.pending_cover_object_key IS NOT NULL
        AND (
            length(NEW.pending_cover_object_key) NOT BETWEEN 1 AND 1024
            OR NEW.pending_cover_object_key = NEW.cover_object_key
            OR julianday(NEW.pending_cover_submitted_at) IS NULL
            OR julianday(NEW.pending_cover_submitted_at) < julianday(NEW.created_at)
        )
    )
BEGIN
    SELECT RAISE(ABORT, 'FUDABA_PENDING_COVER_INVALID');
END;

DROP TRIGGER fudaba_office_cards_active_insert;
DROP TRIGGER fudaba_office_cards_active_update;
DROP TRIGGER fudaba_messages_active_insert;
DROP TRIGGER fudaba_exchanges_active_insert;

CREATE TRIGGER fudaba_office_cards_active_insert
BEFORE INSERT ON fudaba_office_cards
WHEN NOT EXISTS (
    SELECT 1 FROM fudaba_offices
    WHERE id = NEW.office_id AND status = 'active'
)
BEGIN
    SELECT RAISE(ABORT, 'FUDABA_OFFICE_UNAVAILABLE');
END;

CREATE TRIGGER fudaba_office_cards_active_update
BEFORE UPDATE ON fudaba_office_cards
WHEN NOT EXISTS (
    SELECT 1 FROM fudaba_offices
    WHERE id = NEW.office_id AND status = 'active'
)
BEGIN
    SELECT RAISE(ABORT, 'FUDABA_OFFICE_UNAVAILABLE');
END;

CREATE TRIGGER fudaba_messages_active_insert
BEFORE INSERT ON fudaba_messages
WHEN NOT EXISTS (
    SELECT 1 FROM fudaba_offices
    WHERE id = NEW.office_id AND status = 'active'
)
BEGIN
    SELECT RAISE(ABORT, 'FUDABA_OFFICE_UNAVAILABLE');
END;

CREATE TRIGGER fudaba_exchanges_active_insert
BEFORE INSERT ON fudaba_exchange_requests
WHEN NOT EXISTS (
    SELECT 1 FROM fudaba_offices
    WHERE id = NEW.office_id AND status = 'active'
)
BEGIN
    SELECT RAISE(ABORT, 'FUDABA_OFFICE_UNAVAILABLE');
END;

CREATE TRIGGER fudaba_office_cards_transition_insert
BEFORE INSERT ON fudaba_office_cards
WHEN typeof(NEW.revision) <> 'integer'
    OR NEW.revision <> 0
    OR julianday(NEW.updated_at) IS NULL
    OR julianday(NEW.updated_at) <> julianday(NEW.pinned_at)
BEGIN
    SELECT RAISE(ABORT, 'FUDABA_PLACEMENT_INVALID_INITIAL_STATE');
END;

CREATE TRIGGER fudaba_office_cards_transition_update
BEFORE UPDATE ON fudaba_office_cards
WHEN NEW.office_id <> OLD.office_id
    OR NEW.card_id <> OLD.card_id
    OR julianday(NEW.pinned_at) <> julianday(OLD.pinned_at)
    OR typeof(NEW.revision) <> 'integer'
    OR NEW.revision <> OLD.revision + 1
    OR julianday(NEW.updated_at) IS NULL
    OR julianday(NEW.updated_at) < julianday(OLD.updated_at)
BEGIN
    SELECT RAISE(ABORT, 'FUDABA_PLACEMENT_STALE_UPDATE');
END;

CREATE TRIGGER fudaba_messages_hidden_insert_check
BEFORE INSERT ON fudaba_messages
WHEN (NEW.hidden_at IS NULL) <> (NEW.hidden_by_account_id IS NULL)
    OR (
        NEW.hidden_at IS NOT NULL
        AND (
            julianday(NEW.hidden_at) IS NULL
            OR julianday(NEW.hidden_at) < julianday(NEW.created_at)
        )
    )
BEGIN
    SELECT RAISE(ABORT, 'FUDABA_MESSAGE_HIDDEN_STATE_INVALID');
END;

CREATE TRIGGER fudaba_messages_hidden_update_check
BEFORE UPDATE OF hidden_at, hidden_by_account_id, created_at ON fudaba_messages
WHEN (NEW.hidden_at IS NULL) <> (NEW.hidden_by_account_id IS NULL)
    OR (
        NEW.hidden_at IS NOT NULL
        AND (
            julianday(NEW.hidden_at) IS NULL
            OR julianday(NEW.hidden_at) < julianday(NEW.created_at)
        )
    )
BEGIN
    SELECT RAISE(ABORT, 'FUDABA_MESSAGE_HIDDEN_STATE_INVALID');
END;

COMMIT;
