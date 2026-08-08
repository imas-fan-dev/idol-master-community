-- ims:migration-phase: post-data

ALTER TABLE public.fudaba_offices
    ADD COLUMN pending_cover_object_key TEXT,
    ADD COLUMN pending_cover_submitted_at TIMESTAMPTZ,
    ADD CONSTRAINT fudaba_offices_pending_cover_check CHECK (
        (
            pending_cover_object_key IS NULL
            AND pending_cover_submitted_at IS NULL
        ) OR (
            pending_cover_object_key IS NOT NULL
            AND length(pending_cover_object_key) BETWEEN 1 AND 1024
            AND pending_cover_submitted_at IS NOT NULL
            AND pending_cover_submitted_at >= created_at
            AND pending_cover_object_key IS DISTINCT FROM cover_object_key
        )
    );

CREATE INDEX fudaba_offices_pending_cover_idx
    ON public.fudaba_offices(pending_cover_submitted_at, id)
    WHERE pending_cover_object_key IS NOT NULL;

ALTER TABLE public.fudaba_office_cards
    ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK (
        revision BETWEEN 0 AND 2147483647
    ),
    ADD COLUMN updated_at TIMESTAMPTZ;

UPDATE public.fudaba_office_cards SET updated_at = pinned_at;

ALTER TABLE public.fudaba_office_cards
    ALTER COLUMN updated_at SET NOT NULL,
    ADD CONSTRAINT fudaba_office_cards_updated_at_check CHECK (
        updated_at >= pinned_at
    );

ALTER TABLE public.fudaba_messages
    ADD COLUMN hidden_by_account_id TEXT
        REFERENCES public.platform_accounts(id) ON DELETE RESTRICT,
    ADD CONSTRAINT fudaba_messages_hidden_state_check CHECK (
        (hidden_at IS NULL) = (hidden_by_account_id IS NULL)
    );

DROP INDEX public.fudaba_messages_office_time_idx;
CREATE INDEX fudaba_messages_office_time_idx
    ON public.fudaba_messages(office_id, created_at DESC, id DESC)
    WHERE hidden_at IS NULL;
CREATE INDEX fudaba_messages_hidden_by_idx
    ON public.fudaba_messages(hidden_by_account_id, hidden_at DESC, id)
    WHERE hidden_by_account_id IS NOT NULL;

CREATE TABLE public.fudaba_geocoder_cache (
    provider TEXT NOT NULL CHECK (
        length(provider) BETWEEN 1 AND 64
        AND provider ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    ),
    query_hash TEXT NOT NULL CHECK (query_hash ~ '^[0-9a-f]{64}$'),
    response_json TEXT NOT NULL CHECK (
        octet_length(response_json) BETWEEN 2 AND 65536
        AND jsonb_typeof(response_json::jsonb) IN ('object', 'array')
    ),
    expires_at BIGINT NOT NULL CHECK (
        expires_at BETWEEN 1 AND 9007199254740991
    ),
    updated_at BIGINT NOT NULL CHECK (
        updated_at BETWEEN 0 AND 9007199254740991
    ),
    PRIMARY KEY (provider, query_hash),
    CHECK (expires_at > updated_at)
);

CREATE INDEX fudaba_geocoder_cache_expires_at_idx
    ON public.fudaba_geocoder_cache(expires_at);

CREATE TABLE public.fudaba_mutation_receipts (
    scope TEXT NOT NULL CHECK (
        length(scope) BETWEEN 1 AND 64
        AND scope ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    ),
    account_id TEXT NOT NULL
        REFERENCES public.platform_accounts(id) ON DELETE RESTRICT,
    key_hash TEXT NOT NULL CHECK (key_hash ~ '^[0-9a-f]{64}$'),
    request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    resource_id TEXT NOT NULL CHECK (
        length(resource_id) BETWEEN 1 AND 128
        AND length(btrim(resource_id, E' \t\n\v\f\r')) > 0
    ),
    created_at BIGINT NOT NULL CHECK (
        created_at BETWEEN 0 AND 9007199254740991
    ),
    PRIMARY KEY (scope, account_id, key_hash)
);

CREATE INDEX fudaba_mutation_receipts_created_at_idx
    ON public.fudaba_mutation_receipts(created_at, scope, account_id);

CREATE OR REPLACE FUNCTION public.fudaba_require_active_office()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    office_status TEXT;
BEGIN
    SELECT status INTO office_status
    FROM public.fudaba_offices
    WHERE id = NEW.office_id
    FOR NO KEY UPDATE;

    IF office_status IS DISTINCT FROM 'active' THEN
        RAISE EXCEPTION 'FUDABA_OFFICE_UNAVAILABLE';
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION public.fudaba_validate_placement_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.updated_at := COALESCE(NEW.updated_at, NEW.pinned_at);
        IF NEW.revision <> 0 OR NEW.updated_at <> NEW.pinned_at THEN
            RAISE EXCEPTION 'FUDABA_PLACEMENT_INVALID_INITIAL_STATE';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.office_id IS DISTINCT FROM OLD.office_id
        OR NEW.card_id IS DISTINCT FROM OLD.card_id
        OR NEW.pinned_at IS DISTINCT FROM OLD.pinned_at
        OR NEW.revision <> OLD.revision + 1
        OR NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'FUDABA_PLACEMENT_STALE_UPDATE';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER fudaba_office_cards_transition_insert_update
BEFORE INSERT OR UPDATE ON public.fudaba_office_cards
FOR EACH ROW EXECUTE FUNCTION public.fudaba_validate_placement_transition();
