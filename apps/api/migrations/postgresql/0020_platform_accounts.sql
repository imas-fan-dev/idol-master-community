-- ims:migration-phase: pre-data

CREATE TABLE public.platform_accounts (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
    status TEXT NOT NULL CHECK (
        status IN ('active', 'restricted', 'suspended', 'deleted')
    ),
    token_version INTEGER NOT NULL DEFAULT 0 CHECK (token_version >= 0),
    created_at BIGINT NOT NULL CHECK (created_at >= 0),
    updated_at BIGINT NOT NULL CHECK (updated_at >= created_at),
    deleted_at BIGINT,
    CHECK (deleted_at IS NULL OR deleted_at >= created_at),
    CHECK ((status = 'deleted') = (deleted_at IS NOT NULL))
);

CREATE TABLE public.platform_profiles (
    account_id TEXT PRIMARY KEY
        REFERENCES public.platform_accounts(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL CHECK (
        length(btrim(display_name)) BETWEEN 1 AND 80
    ),
    avatar_object_key TEXT CHECK (
        avatar_object_key IS NULL OR length(avatar_object_key) BETWEEN 1 AND 1024
    ),
    avatar_external_url TEXT CHECK (
        avatar_external_url IS NULL OR length(avatar_external_url) BETWEEN 1 AND 2048
    ),
    home_city TEXT CHECK (home_city IS NULL OR length(home_city) <= 100),
    bio TEXT NOT NULL DEFAULT '' CHECK (length(bio) <= 2000),
    updated_at BIGINT NOT NULL CHECK (updated_at >= 0),
    CHECK (avatar_object_key IS NULL OR avatar_external_url IS NULL)
);

CREATE TABLE public.platform_oauth_providers (
    code TEXT PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9-]{0,31}$'),
    display_name TEXT NOT NULL CHECK (
        length(btrim(display_name)) BETWEEN 1 AND 80
    ),
    enabled BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO public.platform_oauth_providers (code, display_name, enabled)
VALUES
    ('google', 'Google', TRUE),
    ('github', 'GitHub', TRUE);

CREATE TABLE public.platform_oauth_identities (
    provider_code TEXT NOT NULL
        REFERENCES public.platform_oauth_providers(code) ON DELETE RESTRICT,
    provider_subject TEXT NOT NULL CHECK (
        length(provider_subject) BETWEEN 1 AND 512
    ),
    account_id TEXT NOT NULL
        REFERENCES public.platform_accounts(id) ON DELETE CASCADE,
    provider_display_name TEXT NOT NULL DEFAULT '' CHECK (
        length(provider_display_name) <= 200
    ),
    provider_avatar_url TEXT NOT NULL DEFAULT '' CHECK (
        length(provider_avatar_url) <= 2048
    ),
    created_at BIGINT NOT NULL CHECK (created_at >= 0),
    updated_at BIGINT NOT NULL CHECK (updated_at >= created_at),
    PRIMARY KEY (provider_code, provider_subject),
    UNIQUE (account_id, provider_code)
);

CREATE INDEX platform_oauth_identities_account_idx
    ON public.platform_oauth_identities(account_id);

CREATE TABLE public.platform_oauth_states (
    state_hash TEXT PRIMARY KEY CHECK (state_hash ~ '^[0-9a-f]{64}$'),
    provider_code TEXT NOT NULL
        REFERENCES public.platform_oauth_providers(code) ON DELETE RESTRICT,
    intent TEXT NOT NULL CHECK (intent IN ('login', 'link')),
    linking_account_id TEXT
        REFERENCES public.platform_accounts(id) ON DELETE CASCADE,
    code_verifier TEXT CHECK (
        code_verifier IS NULL OR length(code_verifier) BETWEEN 43 AND 256
    ),
    return_path TEXT NOT NULL CHECK (
        length(return_path) BETWEEN 1 AND 2048
        AND left(return_path, 1) = '/'
        AND left(return_path, 2) <> '//'
    ),
    expires_at BIGINT NOT NULL CHECK (expires_at >= 0),
    created_at BIGINT NOT NULL CHECK (created_at >= 0),
    CHECK (expires_at > created_at),
    CHECK (
        (intent = 'login' AND linking_account_id IS NULL)
        OR (intent = 'link' AND linking_account_id IS NOT NULL)
    )
);

CREATE INDEX platform_oauth_states_expiry_idx
    ON public.platform_oauth_states(expires_at);

CREATE INDEX platform_oauth_states_linking_account_idx
    ON public.platform_oauth_states(linking_account_id)
    WHERE linking_account_id IS NOT NULL;

CREATE TABLE public.platform_refresh_sessions (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
    account_id TEXT NOT NULL
        REFERENCES public.platform_accounts(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    previous_token_hash TEXT CHECK (
        previous_token_hash IS NULL OR previous_token_hash ~ '^[0-9a-f]{64}$'
    ),
    csrf_hash TEXT NOT NULL CHECK (csrf_hash ~ '^[0-9a-f]{64}$'),
    expires_at BIGINT NOT NULL CHECK (expires_at >= 0),
    created_at BIGINT NOT NULL CHECK (created_at >= 0),
    updated_at BIGINT NOT NULL CHECK (updated_at >= created_at),
    revoked_at BIGINT,
    CHECK (expires_at > created_at),
    CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX platform_refresh_sessions_account_idx
    ON public.platform_refresh_sessions(account_id);

CREATE INDEX platform_refresh_sessions_previous_token_idx
    ON public.platform_refresh_sessions(previous_token_hash)
    WHERE previous_token_hash IS NOT NULL;

CREATE INDEX platform_refresh_sessions_expiry_idx
    ON public.platform_refresh_sessions(expires_at);

CREATE TABLE public.platform_email_credentials (
    normalized_email TEXT PRIMARY KEY CHECK (
        length(normalized_email) BETWEEN 3 AND 320
        AND normalized_email = lower(btrim(normalized_email))
    ),
    account_id TEXT NOT NULL UNIQUE
        REFERENCES public.platform_accounts(id) ON DELETE CASCADE,
    algorithm TEXT NOT NULL CHECK (algorithm IN ('pbkdf2-sha256', 'bcrypt')),
    parameters_json TEXT NOT NULL DEFAULT '{}' CHECK (
        length(parameters_json) BETWEEN 2 AND 4096
        AND jsonb_typeof(parameters_json::jsonb) = 'object'
    ),
    salt TEXT CHECK (salt IS NULL OR length(salt) BETWEEN 1 AND 1024),
    password_hash TEXT NOT NULL CHECK (
        length(password_hash) BETWEEN 1 AND 2048
    ),
    created_at BIGINT NOT NULL CHECK (created_at >= 0),
    updated_at BIGINT NOT NULL CHECK (updated_at >= created_at),
    CHECK (algorithm <> 'pbkdf2-sha256' OR salt IS NOT NULL)
);

CREATE INDEX platform_email_credentials_account_idx
    ON public.platform_email_credentials(account_id);

CREATE TABLE public.platform_security_events (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
    account_id TEXT
        REFERENCES public.platform_accounts(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL CHECK (
        length(event_type) BETWEEN 1 AND 100
        AND event_type ~ '^[a-z][a-z0-9._-]*$'
    ),
    request_id TEXT CHECK (request_id IS NULL OR length(request_id) <= 128),
    ip_address TEXT CHECK (ip_address IS NULL OR length(ip_address) <= 64),
    user_agent TEXT CHECK (user_agent IS NULL OR length(user_agent) <= 1024),
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (
        length(metadata_json) BETWEEN 2 AND 8192
        AND jsonb_typeof(metadata_json::jsonb) = 'object'
    ),
    created_at BIGINT NOT NULL CHECK (created_at >= 0)
);

CREATE INDEX platform_security_events_account_time_idx
    ON public.platform_security_events(account_id, created_at DESC)
    WHERE account_id IS NOT NULL;

CREATE INDEX platform_security_events_type_time_idx
    ON public.platform_security_events(event_type, created_at DESC);
