-- ims:migration-phase: post-data

ALTER TABLE public.users RENAME TO backoffice_accounts;
ALTER SEQUENCE public.users_id_seq RENAME TO backoffice_accounts_id_seq;
ALTER TABLE public.backoffice_accounts
    RENAME CONSTRAINT users_pkey TO backoffice_accounts_pkey;
ALTER TABLE public.backoffice_accounts
    RENAME CONSTRAINT users_username_key TO backoffice_accounts_username_key;
ALTER TABLE public.backoffice_accounts
    RENAME CONSTRAINT users_id_not_null TO backoffice_accounts_id_not_null;
ALTER TABLE public.backoffice_accounts
    RENAME CONSTRAINT users_admin_role_matches_department_check
    TO backoffice_accounts_admin_role_matches_department_check;
ALTER INDEX public.users_one_super_admin_idx
    RENAME TO backoffice_accounts_one_super_admin_idx;

ALTER TABLE public.auth_refresh_sessions RENAME TO backoffice_refresh_sessions;
ALTER TABLE public.backoffice_refresh_sessions RENAME COLUMN user_id TO account_id;
ALTER TABLE public.backoffice_refresh_sessions
    RENAME CONSTRAINT auth_refresh_sessions_pkey
    TO backoffice_refresh_sessions_pkey;
ALTER TABLE public.backoffice_refresh_sessions
    RENAME CONSTRAINT auth_refresh_sessions_id_not_null
    TO backoffice_refresh_sessions_id_not_null;
ALTER TABLE public.backoffice_refresh_sessions
    RENAME CONSTRAINT auth_refresh_sessions_user_id_fkey
    TO backoffice_refresh_sessions_account_id_fkey;
ALTER TABLE public.backoffice_refresh_sessions
    RENAME CONSTRAINT auth_refresh_sessions_user_id_not_null
    TO backoffice_refresh_sessions_account_id_not_null;
ALTER TABLE public.backoffice_refresh_sessions
    RENAME CONSTRAINT auth_refresh_sessions_token_hash_key
    TO backoffice_refresh_sessions_token_hash_key;
ALTER TABLE public.backoffice_refresh_sessions
    RENAME CONSTRAINT auth_refresh_sessions_token_hash_not_null
    TO backoffice_refresh_sessions_token_hash_not_null;
ALTER TABLE public.backoffice_refresh_sessions
    RENAME CONSTRAINT auth_refresh_sessions_token_hash_check
    TO backoffice_refresh_sessions_token_hash_check;
ALTER TABLE public.backoffice_refresh_sessions
    RENAME CONSTRAINT auth_refresh_sessions_previous_token_hash_check
    TO backoffice_refresh_sessions_previous_token_hash_check;
ALTER TABLE public.backoffice_refresh_sessions
    RENAME CONSTRAINT auth_refresh_sessions_csrf_hash_check
    TO backoffice_refresh_sessions_csrf_hash_check;
ALTER TABLE public.backoffice_refresh_sessions
    RENAME CONSTRAINT auth_refresh_sessions_csrf_hash_not_null
    TO backoffice_refresh_sessions_csrf_hash_not_null;
ALTER TABLE public.backoffice_refresh_sessions
    RENAME CONSTRAINT auth_refresh_sessions_expires_at_not_null
    TO backoffice_refresh_sessions_expires_at_not_null;
ALTER TABLE public.backoffice_refresh_sessions
    RENAME CONSTRAINT auth_refresh_sessions_created_at_not_null
    TO backoffice_refresh_sessions_created_at_not_null;
ALTER TABLE public.backoffice_refresh_sessions
    RENAME CONSTRAINT auth_refresh_sessions_updated_at_not_null
    TO backoffice_refresh_sessions_updated_at_not_null;
ALTER INDEX public.idx_auth_refresh_sessions_previous_token
    RENAME TO backoffice_refresh_sessions_previous_token_idx;
ALTER INDEX public.idx_auth_refresh_sessions_expiry
    RENAME TO backoffice_refresh_sessions_expiry_idx;

CREATE INDEX backoffice_refresh_sessions_account_idx
    ON public.backoffice_refresh_sessions(account_id);

CREATE VIEW public.users AS
SELECT id, username, password, dept, producername, admin_role
FROM public.backoffice_accounts;

CREATE VIEW public.auth_refresh_sessions AS
SELECT id, account_id AS user_id, token_hash, previous_token_hash, csrf_hash,
       expires_at, created_at, updated_at, revoked_at
FROM public.backoffice_refresh_sessions;

COMMENT ON VIEW public.users IS
    'Temporary rolling-deployment compatibility view; use backoffice_accounts.';
COMMENT ON VIEW public.auth_refresh_sessions IS
    'Temporary rolling-deployment compatibility view; use backoffice_refresh_sessions.';
