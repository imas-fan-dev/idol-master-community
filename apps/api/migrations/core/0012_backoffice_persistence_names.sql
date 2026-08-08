PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;

-- SQLite keeps the previous release's physical names for one rolling-deploy
-- window. The new Backoffice names remain read aliases until a later cleanup.
ALTER TABLE users ADD COLUMN admin_role TEXT;
UPDATE users
SET admin_role='admin'
WHERE dept='op' AND admin_role IS NULL;

CREATE INDEX idx_auth_refresh_sessions_user
    ON auth_refresh_sessions(user_id);
CREATE UNIQUE INDEX users_one_super_admin_idx
    ON users(admin_role)
    WHERE admin_role='super_admin';

CREATE TRIGGER users_admin_role_insert_check
BEFORE INSERT ON users
WHEN (NEW.dept = 'op' AND (
        NEW.admin_role IS NULL OR
        NEW.admin_role NOT IN ('admin', 'super_admin')
    )) OR (
        COALESCE(NEW.dept, '') <> 'op' AND NEW.admin_role IS NOT NULL
    )
BEGIN
    SELECT RAISE(ABORT, 'users.admin_role does not match dept');
END;

CREATE TRIGGER users_admin_role_update_check
BEFORE UPDATE OF dept, admin_role ON users
WHEN (NEW.dept = 'op' AND (
        NEW.admin_role IS NULL OR
        NEW.admin_role NOT IN ('admin', 'super_admin')
    )) OR (
        COALESCE(NEW.dept, '') <> 'op' AND NEW.admin_role IS NOT NULL
    )
BEGIN
    SELECT RAISE(ABORT, 'users.admin_role does not match dept');
END;

CREATE VIEW backoffice_accounts AS
SELECT id, username, password, dept, producername, admin_role
FROM users;

CREATE VIEW backoffice_refresh_sessions AS
SELECT id, user_id AS account_id, token_hash, previous_token_hash, csrf_hash,
       expires_at, created_at, updated_at, revoked_at
FROM auth_refresh_sessions;

COMMIT;
