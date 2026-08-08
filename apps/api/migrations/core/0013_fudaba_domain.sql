PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS fudaba_offices (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
    owner_account_id TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE CHECK (
        length(slug) BETWEEN 1 AND 120
        AND slug = lower(slug)
        AND slug NOT GLOB '*[^a-z0-9一-龥-]*'
        AND slug NOT GLOB '-*'
        AND slug NOT GLOB '*-'
        AND slug NOT GLOB '*--*'
    ),
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
    intro TEXT NOT NULL DEFAULT '' CHECK (length(intro) <= 2000),
    city TEXT NOT NULL CHECK (length(trim(city)) BETWEEN 1 AND 100),
    address TEXT NOT NULL CHECK (length(trim(address)) BETWEEN 1 AND 240),
    latitude REAL NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    longitude REAL NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    accent TEXT NOT NULL DEFAULT '#ef5b6c' CHECK (
        length(accent) = 7
        AND substr(accent, 1, 1) = '#'
        AND substr(accent, 2) NOT GLOB '*[^0-9A-Fa-f]*'
    ),
    cover_object_key TEXT CHECK (
        cover_object_key IS NULL OR length(cover_object_key) BETWEEN 1 AND 1024
    ),
    is_open INTEGER NOT NULL DEFAULT 1 CHECK (is_open IN (0, 1)),
    visitor_count INTEGER NOT NULL DEFAULT 0 CHECK (
        visitor_count BETWEEN 0 AND 9007199254740991
    ),
    status TEXT NOT NULL DEFAULT 'active' CHECK (
        status IN ('active', 'hidden', 'archived')
    ),
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
    updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
    archived_at TEXT CHECK (archived_at IS NULL OR julianday(archived_at) IS NOT NULL),
    CHECK (julianday(updated_at) >= julianday(created_at)),
    CHECK (archived_at IS NULL OR julianday(archived_at) >= julianday(created_at)),
    CHECK ((status = 'archived') = (archived_at IS NOT NULL)),
    FOREIGN KEY(owner_account_id) REFERENCES platform_accounts(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_fudaba_offices_owner
    ON fudaba_offices(owner_account_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_fudaba_offices_coordinates
    ON fudaba_offices(latitude, longitude);
CREATE INDEX IF NOT EXISTS idx_fudaba_offices_city
    ON fudaba_offices(city);
CREATE INDEX IF NOT EXISTS idx_fudaba_offices_discovery
    ON fudaba_offices(status, is_open, visitor_count DESC, id);

CREATE TABLE IF NOT EXISTS fudaba_series_tags (
    code TEXT PRIMARY KEY CHECK (
        length(code) BETWEEN 1 AND 40
        AND code = lower(code)
        AND code NOT GLOB '*[^a-z0-9-]*'
        AND code NOT GLOB '-*'
        AND code NOT GLOB '*-'
        AND code NOT GLOB '*--*'
    ),
    display_name TEXT NOT NULL UNIQUE CHECK (
        length(trim(display_name)) BETWEEN 1 AND 80
    ),
    display_order INTEGER NOT NULL UNIQUE CHECK (display_order >= 0),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
    updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
    CHECK (julianday(updated_at) >= julianday(created_at))
);

INSERT OR IGNORE INTO fudaba_series_tags
    (code, display_name, display_order, enabled, created_at, updated_at)
VALUES
    ('765as', '本家 / 765AS', 0, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('cinderella', '灰姑娘女孩', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('million-live', '百万现场', 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('sidem', 'SideM', 3, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('shiny-colors', '闪耀色彩', 4, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('gakuen', '学园偶像大师', 5, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('valiv', 'vα-liv', 6, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

CREATE TABLE IF NOT EXISTS fudaba_office_series_tags (
    office_id TEXT NOT NULL,
    series_code TEXT NOT NULL,
    display_order INTEGER NOT NULL CHECK (display_order >= 0),
    PRIMARY KEY (office_id, series_code),
    FOREIGN KEY(office_id) REFERENCES fudaba_offices(id) ON DELETE CASCADE,
    FOREIGN KEY(series_code) REFERENCES fudaba_series_tags(code) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_fudaba_office_series_tags_series
    ON fudaba_office_series_tags(series_code, office_id);

CREATE TABLE IF NOT EXISTS fudaba_cards (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
    owner_account_id TEXT NOT NULL,
    producer_name TEXT NOT NULL CHECK (length(trim(producer_name)) BETWEEN 1 AND 80),
    display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 120),
    series_code TEXT NOT NULL,
    favorite_idol TEXT NOT NULL DEFAULT '' CHECK (length(favorite_idol) <= 200),
    front_object_key TEXT NOT NULL UNIQUE CHECK (
        length(front_object_key) BETWEEN 1 AND 1024
    ),
    back_object_key TEXT NOT NULL UNIQUE CHECK (
        length(back_object_key) BETWEEN 1 AND 1024
    ),
    accent TEXT NOT NULL DEFAULT '#4f64dd' CHECK (
        length(accent) = 7
        AND substr(accent, 1, 1) = '#'
        AND substr(accent, 2) NOT GLOB '*[^0-9A-Fa-f]*'
    ),
    bio TEXT NOT NULL DEFAULT '' CHECK (length(bio) <= 2000),
    trade_note TEXT NOT NULL DEFAULT '' CHECK (length(trade_note) <= 1000),
    available INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0, 1)),
    source_url TEXT CHECK (
        source_url IS NULL OR (
            length(source_url) BETWEEN 1 AND 2048
            AND (source_url GLOB 'http://*' OR source_url GLOB 'https://*')
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
    created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
    updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
    deleted_at TEXT CHECK (deleted_at IS NULL OR julianday(deleted_at) IS NOT NULL),
    UNIQUE (id, owner_account_id),
    CHECK (front_object_key <> back_object_key),
    CHECK (publication_status <> 'published' OR media_rights_status = 'approved'),
    CHECK (julianday(updated_at) >= julianday(created_at)),
    CHECK (deleted_at IS NULL OR julianday(deleted_at) >= julianday(created_at)),
    FOREIGN KEY(owner_account_id) REFERENCES platform_accounts(id) ON DELETE RESTRICT,
    FOREIGN KEY(series_code) REFERENCES fudaba_series_tags(code) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_fudaba_cards_owner
    ON fudaba_cards(owner_account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fudaba_cards_public
    ON fudaba_cards(publication_status, available, created_at DESC)
    WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS fudaba_office_cards (
    office_id TEXT NOT NULL,
    card_id TEXT NOT NULL,
    pinned_at TEXT NOT NULL CHECK (julianday(pinned_at) IS NOT NULL),
    position_x REAL NOT NULL DEFAULT 50 CHECK (position_x BETWEEN 0 AND 100),
    position_y REAL NOT NULL DEFAULT 50 CHECK (position_y BETWEEN 0 AND 100),
    rotation REAL NOT NULL DEFAULT 0 CHECK (rotation BETWEEN -12 AND 12),
    z_index INTEGER NOT NULL DEFAULT 1 CHECK (z_index BETWEEN 1 AND 999),
    PRIMARY KEY (office_id, card_id),
    FOREIGN KEY(office_id) REFERENCES fudaba_offices(id) ON DELETE CASCADE,
    FOREIGN KEY(card_id) REFERENCES fudaba_cards(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_fudaba_office_cards_office_time
    ON fudaba_office_cards(office_id, pinned_at DESC);
CREATE INDEX IF NOT EXISTS idx_fudaba_office_cards_card
    ON fudaba_office_cards(card_id);

CREATE TABLE IF NOT EXISTS fudaba_messages (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
    office_id TEXT NOT NULL,
    author_account_id TEXT NOT NULL,
    content TEXT NOT NULL CHECK (length(trim(content)) BETWEEN 1 AND 280),
    created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
    hidden_at TEXT CHECK (hidden_at IS NULL OR julianday(hidden_at) IS NOT NULL),
    CHECK (hidden_at IS NULL OR julianday(hidden_at) >= julianday(created_at)),
    FOREIGN KEY(office_id) REFERENCES fudaba_offices(id) ON DELETE CASCADE,
    FOREIGN KEY(author_account_id) REFERENCES platform_accounts(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_fudaba_messages_office_time
    ON fudaba_messages(office_id, created_at DESC)
    WHERE hidden_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_fudaba_messages_author
    ON fudaba_messages(author_account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS fudaba_exchange_requests (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
    office_id TEXT NOT NULL,
    requester_account_id TEXT NOT NULL,
    recipient_account_id TEXT NOT NULL,
    wanted_card_id TEXT NOT NULL,
    offered_card_id TEXT,
    note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 1000),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'accepted', 'declined', 'cancelled')
    ),
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
    updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
    resolved_at TEXT CHECK (resolved_at IS NULL OR julianday(resolved_at) IS NOT NULL),
    FOREIGN KEY(office_id, wanted_card_id)
        REFERENCES fudaba_office_cards(office_id, card_id) ON DELETE RESTRICT,
    FOREIGN KEY(requester_account_id)
        REFERENCES platform_accounts(id) ON DELETE RESTRICT,
    FOREIGN KEY(recipient_account_id)
        REFERENCES platform_accounts(id) ON DELETE RESTRICT,
    FOREIGN KEY(wanted_card_id, recipient_account_id)
        REFERENCES fudaba_cards(id, owner_account_id) ON DELETE RESTRICT,
    FOREIGN KEY(offered_card_id, requester_account_id)
        REFERENCES fudaba_cards(id, owner_account_id) ON DELETE RESTRICT,
    FOREIGN KEY(offered_card_id)
        REFERENCES fudaba_cards(id) ON DELETE RESTRICT,
    CHECK (requester_account_id <> recipient_account_id),
    CHECK (offered_card_id IS NULL OR offered_card_id <> wanted_card_id),
    CHECK (julianday(updated_at) >= julianday(created_at)),
    CHECK (
        resolved_at IS NULL OR julianday(resolved_at) BETWEEN
            julianday(created_at) AND julianday(updated_at)
    ),
    CHECK ((status = 'pending') = (resolved_at IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_fudaba_exchange_requests_pending
    ON fudaba_exchange_requests(
        requester_account_id, recipient_account_id, wanted_card_id
    ) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_fudaba_exchange_requests_recipient
    ON fudaba_exchange_requests(recipient_account_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fudaba_exchange_requests_requester
    ON fudaba_exchange_requests(requester_account_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS fudaba_card_likes (
    card_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
    PRIMARY KEY (card_id, account_id),
    FOREIGN KEY(card_id) REFERENCES fudaba_cards(id) ON DELETE CASCADE,
    FOREIGN KEY(account_id) REFERENCES platform_accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_fudaba_card_likes_account
    ON fudaba_card_likes(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS fudaba_card_favorites (
    card_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
    PRIMARY KEY (card_id, account_id),
    FOREIGN KEY(card_id) REFERENCES fudaba_cards(id) ON DELETE CASCADE,
    FOREIGN KEY(account_id) REFERENCES platform_accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_fudaba_card_favorites_account
    ON fudaba_card_favorites(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS fudaba_moderation_cases (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
    resource_kind TEXT NOT NULL CHECK (
        resource_kind IN ('account', 'office', 'card', 'message', 'exchange')
    ),
    resource_id TEXT NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 128),
    reporter_account_id TEXT,
    reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 200),
    details TEXT NOT NULL DEFAULT '' CHECK (length(details) <= 4000),
    state TEXT NOT NULL DEFAULT 'open' CHECK (
        state IN ('open', 'reviewing', 'resolved', 'dismissed', 'appealed')
    ),
    backoffice_actor_id INTEGER,
    resolution TEXT NOT NULL DEFAULT '' CHECK (length(resolution) <= 4000),
    created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
    updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
    resolved_at TEXT CHECK (resolved_at IS NULL OR julianday(resolved_at) IS NOT NULL),
    CHECK (julianday(updated_at) >= julianday(created_at)),
    CHECK (
        resolved_at IS NULL OR julianday(resolved_at) BETWEEN
            julianday(created_at) AND julianday(updated_at)
    ),
    CHECK (
        (state IN ('resolved', 'dismissed') AND resolved_at IS NOT NULL
            AND backoffice_actor_id IS NOT NULL)
        OR (state NOT IN ('resolved', 'dismissed') AND resolved_at IS NULL)
    ),
    FOREIGN KEY(reporter_account_id) REFERENCES platform_accounts(id) ON DELETE SET NULL,
    CONSTRAINT fudaba_moderation_cases_backoffice_actor_fk
        FOREIGN KEY(backoffice_actor_id) REFERENCES users(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_fudaba_moderation_cases_state
    ON fudaba_moderation_cases(state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fudaba_moderation_cases_resource
    ON fudaba_moderation_cases(resource_kind, resource_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fudaba_moderation_cases_reporter
    ON fudaba_moderation_cases(reporter_account_id, created_at DESC)
    WHERE reporter_account_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS fudaba_office_cards_active_insert
BEFORE INSERT ON fudaba_office_cards
WHEN NOT EXISTS (
    SELECT 1 FROM fudaba_offices
    WHERE id = NEW.office_id AND status <> 'archived'
)
BEGIN
    SELECT RAISE(ABORT, 'FUDABA_OFFICE_ARCHIVED');
END;

CREATE TRIGGER IF NOT EXISTS fudaba_office_cards_active_update
BEFORE UPDATE ON fudaba_office_cards
WHEN NOT EXISTS (
    SELECT 1 FROM fudaba_offices
    WHERE id = NEW.office_id AND status <> 'archived'
)
BEGIN
    SELECT RAISE(ABORT, 'FUDABA_OFFICE_ARCHIVED');
END;

CREATE TRIGGER IF NOT EXISTS fudaba_messages_active_insert
BEFORE INSERT ON fudaba_messages
WHEN NOT EXISTS (
    SELECT 1 FROM fudaba_offices
    WHERE id = NEW.office_id AND status <> 'archived'
)
BEGIN
    SELECT RAISE(ABORT, 'FUDABA_OFFICE_ARCHIVED');
END;

CREATE TRIGGER IF NOT EXISTS fudaba_exchanges_active_insert
BEFORE INSERT ON fudaba_exchange_requests
WHEN NOT EXISTS (
    SELECT 1 FROM fudaba_offices
    WHERE id = NEW.office_id AND status <> 'archived'
)
BEGIN
    SELECT RAISE(ABORT, 'FUDABA_OFFICE_ARCHIVED');
END;

CREATE TRIGGER IF NOT EXISTS fudaba_exchange_ownership_insert
BEFORE INSERT ON fudaba_exchange_requests
WHEN NEW.offered_card_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM fudaba_cards
    WHERE id = NEW.offered_card_id
      AND owner_account_id = NEW.requester_account_id
      AND deleted_at IS NULL
)
BEGIN
    SELECT RAISE(ABORT, 'FUDABA_OFFERED_CARD_NOT_OWNED');
END;

CREATE TRIGGER IF NOT EXISTS fudaba_exchange_ownership_update
BEFORE UPDATE OF requester_account_id, offered_card_id ON fudaba_exchange_requests
WHEN NEW.offered_card_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM fudaba_cards
    WHERE id = NEW.offered_card_id
      AND owner_account_id = NEW.requester_account_id
      AND deleted_at IS NULL
)
BEGIN
    SELECT RAISE(ABORT, 'FUDABA_OFFERED_CARD_NOT_OWNED');
END;

CREATE TRIGGER IF NOT EXISTS fudaba_exchange_transition_update
BEFORE UPDATE ON fudaba_exchange_requests
WHEN OLD.status <> 'pending'
  OR NEW.status NOT IN ('pending', 'accepted', 'declined', 'cancelled')
  OR julianday(NEW.updated_at) < julianday(OLD.updated_at)
  OR NEW.version <> OLD.version + 1
BEGIN
    SELECT RAISE(ABORT, 'FUDABA_EXCHANGE_INVALID_TRANSITION');
END;
