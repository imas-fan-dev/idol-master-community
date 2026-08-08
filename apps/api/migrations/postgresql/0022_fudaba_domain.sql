-- ims:migration-phase: post-data

CREATE TABLE public.fudaba_offices (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
    owner_account_id TEXT NOT NULL
        REFERENCES public.platform_accounts(id) ON DELETE RESTRICT,
    slug TEXT NOT NULL UNIQUE CHECK (
        length(slug) BETWEEN 1 AND 120
        AND slug ~ '^[a-z0-9一-龥]+(?:-[a-z0-9一-龥]+)*$'
    ),
    name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
    intro TEXT NOT NULL DEFAULT '' CHECK (length(intro) <= 2000),
    city TEXT NOT NULL CHECK (length(btrim(city)) BETWEEN 1 AND 100),
    address TEXT NOT NULL CHECK (length(btrim(address)) BETWEEN 1 AND 240),
    latitude DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    longitude DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    accent TEXT NOT NULL DEFAULT '#ef5b6c' CHECK (accent ~ '^#[0-9A-Fa-f]{6}$'),
    cover_object_key TEXT CHECK (
        cover_object_key IS NULL OR length(cover_object_key) BETWEEN 1 AND 1024
    ),
    is_open BOOLEAN NOT NULL DEFAULT TRUE,
    visitor_count BIGINT NOT NULL DEFAULT 0 CHECK (
        visitor_count BETWEEN 0 AND 9007199254740991
    ),
    status TEXT NOT NULL DEFAULT 'active' CHECK (
        status IN ('active', 'hidden', 'archived')
    ),
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    archived_at TIMESTAMPTZ,
    CHECK (updated_at >= created_at),
    CHECK (archived_at IS NULL OR archived_at >= created_at),
    CHECK ((status = 'archived') = (archived_at IS NOT NULL))
);

CREATE INDEX fudaba_offices_owner_idx
    ON public.fudaba_offices(owner_account_id, updated_at DESC);
CREATE INDEX fudaba_offices_coordinates_idx
    ON public.fudaba_offices(latitude, longitude);
CREATE INDEX fudaba_offices_city_idx
    ON public.fudaba_offices(city);
CREATE INDEX fudaba_offices_discovery_idx
    ON public.fudaba_offices(status, is_open, visitor_count DESC, id);

CREATE TABLE public.fudaba_series_tags (
    code TEXT PRIMARY KEY CHECK (
        length(code) BETWEEN 1 AND 40
        AND code ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    ),
    display_name TEXT NOT NULL UNIQUE CHECK (
        length(btrim(display_name)) BETWEEN 1 AND 80
    ),
    display_order INTEGER NOT NULL UNIQUE CHECK (display_order >= 0),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CHECK (updated_at >= created_at)
);

INSERT INTO public.fudaba_series_tags
    (code, display_name, display_order, enabled, created_at, updated_at)
VALUES
    ('765as', '本家 / 765AS', 0, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('cinderella', '灰姑娘女孩', 1, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('million-live', '百万现场', 2, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('sidem', 'SideM', 3, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('shiny-colors', '闪耀色彩', 4, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('gakuen', '学园偶像大师', 5, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('valiv', 'vα-liv', 6, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

CREATE TABLE public.fudaba_office_series_tags (
    office_id TEXT NOT NULL
        REFERENCES public.fudaba_offices(id) ON DELETE CASCADE,
    series_code TEXT NOT NULL
        REFERENCES public.fudaba_series_tags(code) ON DELETE RESTRICT,
    display_order INTEGER NOT NULL CHECK (display_order >= 0),
    PRIMARY KEY (office_id, series_code)
);

CREATE INDEX fudaba_office_series_tags_series_idx
    ON public.fudaba_office_series_tags(series_code, office_id);

CREATE TABLE public.fudaba_cards (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
    owner_account_id TEXT NOT NULL
        REFERENCES public.platform_accounts(id) ON DELETE RESTRICT,
    producer_name TEXT NOT NULL CHECK (
        length(btrim(producer_name)) BETWEEN 1 AND 80
    ),
    display_name TEXT NOT NULL CHECK (
        length(btrim(display_name)) BETWEEN 1 AND 120
    ),
    series_code TEXT NOT NULL
        REFERENCES public.fudaba_series_tags(code) ON DELETE RESTRICT,
    favorite_idol TEXT NOT NULL DEFAULT '' CHECK (length(favorite_idol) <= 200),
    front_object_key TEXT NOT NULL UNIQUE CHECK (
        length(front_object_key) BETWEEN 1 AND 1024
    ),
    back_object_key TEXT NOT NULL UNIQUE CHECK (
        length(back_object_key) BETWEEN 1 AND 1024
    ),
    accent TEXT NOT NULL DEFAULT '#4f64dd' CHECK (accent ~ '^#[0-9A-Fa-f]{6}$'),
    bio TEXT NOT NULL DEFAULT '' CHECK (length(bio) <= 2000),
    trade_note TEXT NOT NULL DEFAULT '' CHECK (length(trade_note) <= 1000),
    available BOOLEAN NOT NULL DEFAULT TRUE,
    source_url TEXT CHECK (
        source_url IS NULL OR (
            length(source_url) BETWEEN 1 AND 2048
            AND source_url ~ '^https?://'
        )
    ),
    source_label TEXT CHECK (source_label IS NULL OR length(source_label) <= 200),
    source_credit TEXT CHECK (source_credit IS NULL OR length(source_credit) <= 200),
    media_rights_status TEXT NOT NULL DEFAULT 'unknown' CHECK (
        media_rights_status IN ('unknown', 'approved', 'denied')
    ),
    publication_status TEXT NOT NULL DEFAULT 'draft' CHECK (
        publication_status IN ('draft', 'pending', 'published', 'hidden', 'rejected')
    ),
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    deleted_at TIMESTAMPTZ,
    UNIQUE (id, owner_account_id),
    CHECK (front_object_key <> back_object_key),
    CHECK (publication_status <> 'published' OR media_rights_status = 'approved'),
    CHECK (updated_at >= created_at),
    CHECK (deleted_at IS NULL OR deleted_at >= created_at)
);

CREATE INDEX fudaba_cards_owner_idx
    ON public.fudaba_cards(owner_account_id, created_at DESC);
CREATE INDEX fudaba_cards_public_idx
    ON public.fudaba_cards(publication_status, available, created_at DESC)
    WHERE deleted_at IS NULL;

CREATE TABLE public.fudaba_office_cards (
    office_id TEXT NOT NULL
        REFERENCES public.fudaba_offices(id) ON DELETE CASCADE,
    card_id TEXT NOT NULL
        REFERENCES public.fudaba_cards(id) ON DELETE CASCADE,
    pinned_at TIMESTAMPTZ NOT NULL,
    position_x DOUBLE PRECISION NOT NULL DEFAULT 50 CHECK (position_x BETWEEN 0 AND 100),
    position_y DOUBLE PRECISION NOT NULL DEFAULT 50 CHECK (position_y BETWEEN 0 AND 100),
    rotation DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (rotation BETWEEN -12 AND 12),
    z_index INTEGER NOT NULL DEFAULT 1 CHECK (z_index BETWEEN 1 AND 999),
    PRIMARY KEY (office_id, card_id)
);

CREATE INDEX fudaba_office_cards_office_time_idx
    ON public.fudaba_office_cards(office_id, pinned_at DESC);
CREATE INDEX fudaba_office_cards_card_idx
    ON public.fudaba_office_cards(card_id);

CREATE TABLE public.fudaba_messages (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
    office_id TEXT NOT NULL
        REFERENCES public.fudaba_offices(id) ON DELETE CASCADE,
    author_account_id TEXT NOT NULL
        REFERENCES public.platform_accounts(id) ON DELETE RESTRICT,
    content TEXT NOT NULL CHECK (length(btrim(content)) BETWEEN 1 AND 280),
    created_at TIMESTAMPTZ NOT NULL,
    hidden_at TIMESTAMPTZ,
    CHECK (hidden_at IS NULL OR hidden_at >= created_at)
);

CREATE INDEX fudaba_messages_office_time_idx
    ON public.fudaba_messages(office_id, created_at DESC)
    WHERE hidden_at IS NULL;
CREATE INDEX fudaba_messages_author_idx
    ON public.fudaba_messages(author_account_id, created_at DESC);

CREATE TABLE public.fudaba_exchange_requests (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
    office_id TEXT NOT NULL,
    requester_account_id TEXT NOT NULL
        REFERENCES public.platform_accounts(id) ON DELETE RESTRICT,
    recipient_account_id TEXT NOT NULL
        REFERENCES public.platform_accounts(id) ON DELETE RESTRICT,
    wanted_card_id TEXT NOT NULL,
    offered_card_id TEXT
        REFERENCES public.fudaba_cards(id) ON DELETE RESTRICT,
    note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 1000),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'accepted', 'declined', 'cancelled')
    ),
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    resolved_at TIMESTAMPTZ,
    FOREIGN KEY (office_id, wanted_card_id)
        REFERENCES public.fudaba_office_cards(office_id, card_id) ON DELETE RESTRICT,
    FOREIGN KEY (wanted_card_id, recipient_account_id)
        REFERENCES public.fudaba_cards(id, owner_account_id) ON DELETE RESTRICT,
    FOREIGN KEY (offered_card_id, requester_account_id)
        REFERENCES public.fudaba_cards(id, owner_account_id) ON DELETE RESTRICT,
    CHECK (requester_account_id <> recipient_account_id),
    CHECK (offered_card_id IS NULL OR offered_card_id <> wanted_card_id),
    CHECK (updated_at >= created_at),
    CHECK (resolved_at IS NULL OR resolved_at BETWEEN created_at AND updated_at),
    CHECK ((status = 'pending') = (resolved_at IS NULL))
);

CREATE UNIQUE INDEX fudaba_exchange_requests_pending_idx
    ON public.fudaba_exchange_requests(
        requester_account_id, recipient_account_id, wanted_card_id
    ) WHERE status = 'pending';
CREATE INDEX fudaba_exchange_requests_recipient_idx
    ON public.fudaba_exchange_requests(recipient_account_id, status, created_at DESC);
CREATE INDEX fudaba_exchange_requests_requester_idx
    ON public.fudaba_exchange_requests(requester_account_id, status, created_at DESC);

CREATE TABLE public.fudaba_card_likes (
    card_id TEXT NOT NULL
        REFERENCES public.fudaba_cards(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL
        REFERENCES public.platform_accounts(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (card_id, account_id)
);

CREATE INDEX fudaba_card_likes_account_idx
    ON public.fudaba_card_likes(account_id, created_at DESC);

CREATE TABLE public.fudaba_card_favorites (
    card_id TEXT NOT NULL
        REFERENCES public.fudaba_cards(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL
        REFERENCES public.platform_accounts(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (card_id, account_id)
);

CREATE INDEX fudaba_card_favorites_account_idx
    ON public.fudaba_card_favorites(account_id, created_at DESC);

CREATE TABLE public.fudaba_moderation_cases (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
    resource_kind TEXT NOT NULL CHECK (
        resource_kind IN ('account', 'office', 'card', 'message', 'exchange')
    ),
    resource_id TEXT NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 128),
    reporter_account_id TEXT
        REFERENCES public.platform_accounts(id) ON DELETE SET NULL,
    reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 200),
    details TEXT NOT NULL DEFAULT '' CHECK (length(details) <= 4000),
    state TEXT NOT NULL DEFAULT 'open' CHECK (
        state IN ('open', 'reviewing', 'resolved', 'dismissed', 'appealed')
    ),
    backoffice_actor_id BIGINT,
    resolution TEXT NOT NULL DEFAULT '' CHECK (length(resolution) <= 4000),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    resolved_at TIMESTAMPTZ,
    CHECK (updated_at >= created_at),
    CHECK (resolved_at IS NULL OR resolved_at BETWEEN created_at AND updated_at),
    CHECK (
        (state IN ('resolved', 'dismissed') AND resolved_at IS NOT NULL
            AND backoffice_actor_id IS NOT NULL)
        OR (state NOT IN ('resolved', 'dismissed') AND resolved_at IS NULL)
    ),
    CONSTRAINT fudaba_moderation_cases_backoffice_actor_fk
        FOREIGN KEY (backoffice_actor_id)
        REFERENCES public.backoffice_accounts(id) ON DELETE RESTRICT
);

CREATE INDEX fudaba_moderation_cases_state_idx
    ON public.fudaba_moderation_cases(state, created_at DESC);
CREATE INDEX fudaba_moderation_cases_resource_idx
    ON public.fudaba_moderation_cases(resource_kind, resource_id, created_at DESC);
CREATE INDEX fudaba_moderation_cases_reporter_idx
    ON public.fudaba_moderation_cases(reporter_account_id, created_at DESC)
    WHERE reporter_account_id IS NOT NULL;

CREATE FUNCTION public.fudaba_require_active_office()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.fudaba_offices
        WHERE id = NEW.office_id AND status <> 'archived'
    ) THEN
        RAISE EXCEPTION 'FUDABA_OFFICE_ARCHIVED';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER fudaba_office_cards_active_insert
BEFORE INSERT OR UPDATE ON public.fudaba_office_cards
FOR EACH ROW EXECUTE FUNCTION public.fudaba_require_active_office();
CREATE TRIGGER fudaba_messages_active_insert
BEFORE INSERT ON public.fudaba_messages
FOR EACH ROW EXECUTE FUNCTION public.fudaba_require_active_office();
CREATE TRIGGER fudaba_exchanges_active_insert
BEFORE INSERT ON public.fudaba_exchange_requests
FOR EACH ROW EXECUTE FUNCTION public.fudaba_require_active_office();

CREATE FUNCTION public.fudaba_validate_exchange_ownership()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.offered_card_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.fudaba_cards
        WHERE id = NEW.offered_card_id
          AND owner_account_id = NEW.requester_account_id
          AND deleted_at IS NULL
    ) THEN
        RAISE EXCEPTION 'FUDABA_OFFERED_CARD_NOT_OWNED';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER fudaba_exchange_ownership_insert_update
BEFORE INSERT OR UPDATE OF requester_account_id, offered_card_id
ON public.fudaba_exchange_requests
FOR EACH ROW EXECUTE FUNCTION public.fudaba_validate_exchange_ownership();

CREATE FUNCTION public.fudaba_validate_exchange_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.status <> 'pending' THEN
        RAISE EXCEPTION 'FUDABA_EXCHANGE_INVALID_TRANSITION';
    END IF;
    IF NEW.status NOT IN ('pending', 'accepted', 'declined', 'cancelled') THEN
        RAISE EXCEPTION 'FUDABA_EXCHANGE_INVALID_TRANSITION';
    END IF;
    IF NEW.updated_at < OLD.updated_at OR NEW.version <> OLD.version + 1 THEN
        RAISE EXCEPTION 'FUDABA_EXCHANGE_STALE_UPDATE';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER fudaba_exchange_transition_update
BEFORE UPDATE ON public.fudaba_exchange_requests
FOR EACH ROW EXECUTE FUNCTION public.fudaba_validate_exchange_transition();
