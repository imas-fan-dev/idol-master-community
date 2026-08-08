PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS platform_accounts (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
    status TEXT NOT NULL CHECK (
        status IN ('active', 'restricted', 'suspended', 'deleted')
    ),
    token_version INTEGER NOT NULL DEFAULT 0 CHECK (token_version >= 0),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    deleted_at INTEGER,
    CHECK (deleted_at IS NULL OR deleted_at >= created_at),
    CHECK ((status = 'deleted') = (deleted_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS platform_profiles (
    account_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL CHECK (
        length(trim(display_name)) BETWEEN 1 AND 80
    ),
    avatar_object_key TEXT CHECK (
        avatar_object_key IS NULL OR length(avatar_object_key) BETWEEN 1 AND 1024
    ),
    avatar_external_url TEXT CHECK (
        avatar_external_url IS NULL OR length(avatar_external_url) BETWEEN 1 AND 2048
    ),
    home_city TEXT CHECK (home_city IS NULL OR length(home_city) <= 100),
    bio TEXT NOT NULL DEFAULT '' CHECK (length(bio) <= 2000),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
    CHECK (avatar_object_key IS NULL OR avatar_external_url IS NULL),
    FOREIGN KEY(account_id) REFERENCES platform_accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS platform_oauth_providers (
    code TEXT PRIMARY KEY CHECK (
        length(code) BETWEEN 1 AND 32
        AND substr(code, 1, 1) GLOB '[a-z]'
        AND code = lower(code)
        AND code NOT GLOB '*[^a-z0-9-]*'
    ),
    display_name TEXT NOT NULL CHECK (
        length(trim(display_name)) BETWEEN 1 AND 80
    ),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
);

INSERT OR IGNORE INTO platform_oauth_providers (code, display_name, enabled)
VALUES
    ('google', 'Google', 1),
    ('github', 'GitHub', 1);

CREATE TABLE IF NOT EXISTS platform_oauth_identities (
    provider_code TEXT NOT NULL,
    provider_subject TEXT NOT NULL CHECK (
        length(provider_subject) BETWEEN 1 AND 512
    ),
    account_id TEXT NOT NULL,
    provider_display_name TEXT NOT NULL DEFAULT '' CHECK (
        length(provider_display_name) <= 200
    ),
    provider_avatar_url TEXT NOT NULL DEFAULT '' CHECK (
        length(provider_avatar_url) <= 2048
    ),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    PRIMARY KEY (provider_code, provider_subject),
    UNIQUE (account_id, provider_code),
    FOREIGN KEY(provider_code)
        REFERENCES platform_oauth_providers(code) ON DELETE RESTRICT,
    FOREIGN KEY(account_id) REFERENCES platform_accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_platform_oauth_identities_account
    ON platform_oauth_identities(account_id);

CREATE TABLE IF NOT EXISTS platform_oauth_states (
    state_hash TEXT PRIMARY KEY CHECK (
        length(state_hash) = 64
        AND state_hash = lower(state_hash)
        AND state_hash NOT GLOB '*[^a-f0-9]*'
    ),
    provider_code TEXT NOT NULL,
    intent TEXT NOT NULL CHECK (intent IN ('login', 'link')),
    linking_account_id TEXT,
    code_verifier TEXT CHECK (
        code_verifier IS NULL OR length(code_verifier) BETWEEN 43 AND 256
    ),
    return_path TEXT NOT NULL CHECK (
        length(return_path) BETWEEN 1 AND 2048
        AND substr(return_path, 1, 1) = '/'
        AND substr(return_path, 1, 2) <> '//'
    ),
    expires_at INTEGER NOT NULL CHECK (expires_at >= 0),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    CHECK (expires_at > created_at),
    CHECK (
        (intent = 'login' AND linking_account_id IS NULL)
        OR (intent = 'link' AND linking_account_id IS NOT NULL)
    ),
    FOREIGN KEY(provider_code)
        REFERENCES platform_oauth_providers(code) ON DELETE RESTRICT,
    FOREIGN KEY(linking_account_id)
        REFERENCES platform_accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_platform_oauth_states_expiry
    ON platform_oauth_states(expires_at);

CREATE INDEX IF NOT EXISTS idx_platform_oauth_states_linking_account
    ON platform_oauth_states(linking_account_id)
    WHERE linking_account_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS platform_refresh_sessions (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
    account_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE CHECK (
        length(token_hash) = 64
        AND token_hash = lower(token_hash)
        AND token_hash NOT GLOB '*[^a-f0-9]*'
    ),
    previous_token_hash TEXT CHECK (
        previous_token_hash IS NULL OR (
            length(previous_token_hash) = 64
            AND previous_token_hash = lower(previous_token_hash)
            AND previous_token_hash NOT GLOB '*[^a-f0-9]*'
        )
    ),
    csrf_hash TEXT NOT NULL CHECK (
        length(csrf_hash) = 64
        AND csrf_hash = lower(csrf_hash)
        AND csrf_hash NOT GLOB '*[^a-f0-9]*'
    ),
    expires_at INTEGER NOT NULL CHECK (expires_at >= 0),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    revoked_at INTEGER,
    CHECK (expires_at > created_at),
    CHECK (revoked_at IS NULL OR revoked_at >= created_at),
    FOREIGN KEY(account_id) REFERENCES platform_accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_platform_refresh_sessions_account
    ON platform_refresh_sessions(account_id);

CREATE INDEX IF NOT EXISTS idx_platform_refresh_sessions_previous_token
    ON platform_refresh_sessions(previous_token_hash)
    WHERE previous_token_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_platform_refresh_sessions_expiry
    ON platform_refresh_sessions(expires_at);

CREATE TABLE IF NOT EXISTS platform_email_credentials (
    normalized_email TEXT PRIMARY KEY CHECK (
        length(normalized_email) BETWEEN 3 AND 320
        AND normalized_email = lower(trim(normalized_email))
    ),
    account_id TEXT NOT NULL UNIQUE,
    algorithm TEXT NOT NULL CHECK (
        algorithm IN ('pbkdf2-sha256', 'bcrypt')
    ),
    parameters_json TEXT NOT NULL DEFAULT '{}' CHECK (
        length(parameters_json) BETWEEN 2 AND 4096
        AND json_valid(parameters_json) = 1
        AND json_type(parameters_json) = 'object'
    ),
    salt TEXT CHECK (salt IS NULL OR length(salt) BETWEEN 1 AND 1024),
    password_hash TEXT NOT NULL CHECK (
        length(password_hash) BETWEEN 1 AND 2048
    ),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    CHECK (algorithm <> 'pbkdf2-sha256' OR salt IS NOT NULL),
    FOREIGN KEY(account_id) REFERENCES platform_accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_platform_email_credentials_account
    ON platform_email_credentials(account_id);

CREATE TABLE IF NOT EXISTS platform_security_events (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
    account_id TEXT,
    event_type TEXT NOT NULL CHECK (
        length(event_type) BETWEEN 1 AND 100
        AND substr(event_type, 1, 1) GLOB '[a-z]'
        AND event_type = lower(event_type)
        AND event_type NOT GLOB '*[^a-z0-9._-]*'
    ),
    request_id TEXT CHECK (request_id IS NULL OR length(request_id) <= 128),
    ip_address TEXT CHECK (ip_address IS NULL OR length(ip_address) <= 64),
    user_agent TEXT CHECK (user_agent IS NULL OR length(user_agent) <= 1024),
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (
        length(metadata_json) BETWEEN 2 AND 8192
        AND json_valid(metadata_json) = 1
        AND json_type(metadata_json) = 'object'
    ),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    FOREIGN KEY(account_id) REFERENCES platform_accounts(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_platform_security_events_account_time
    ON platform_security_events(account_id, created_at DESC)
    WHERE account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_platform_security_events_type_time
    ON platform_security_events(event_type, created_at DESC);
