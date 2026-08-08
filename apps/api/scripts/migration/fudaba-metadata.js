'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const sqlite3 = require('sqlite3');

const FUDABA_COMMIT = '544d362acfb7af28d90f9a9e59f3a8757661dd77';
const FUDABA_REPOSITORY = 'https://github.com/imas-fan-dev/Fudaba';
const FUDABA_D1_DATABASE_ID = 'e585a1b9-16dd-460a-92b2-94f0017a1ead';
const FUDABA_R2_BUCKET = 'imas-world-card-images';
const FUDABA_MIGRATIONS = [
    '0001_initial.sql',
    '0002_official_demo_card_art.sql',
    '0003_public_card_users.sql',
    '0004_interactive_card_wall.sql',
    '0005_oauth_profiles.sql',
    '0006_office_series_tags.sql',
    '0007_office_management.sql',
    '0008_series_office_covers.sql',
    '0009_card_interactions.sql',
    '0010_email_credentials.sql'
];
const SOURCE_CLASSIFICATIONS = new Set([
    'production-user-content',
    'owner-approved-reference',
    'demo-or-synthetic',
    'unknown'
]);
const INCLUDED_CLASSIFICATIONS = new Set([
    'production-user-content',
    'owner-approved-reference'
]);
const SERIES_MAPPINGS = new Map([
    ['本家 / 765AS', { code: '765', order: 0 }],
    ['灰姑娘女孩', { code: 'cg', order: 1 }],
    ['百万现场', { code: 'ml', order: 2 }],
    ['SideM', { code: 'sidem', order: 3 }],
    ['闪耀色彩', { code: 'sc', order: 4 }],
    ['学园偶像大师', { code: 'gk', order: 5 }],
    ['vα-liv', { code: null, order: 6 }]
]);
const DEFAULT_SNAPSHOT_ROOT = path.resolve(__dirname, '../../../../data/migration/fudaba');
const SNAPSHOT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SOURCE_TABLES = {
    users: {
        key: ['id'],
        columns: [
            'id', 'display_name', 'avatar_url', 'home_city', 'created_at', 'bio', 'updated_at'
        ]
    },
    oauth_accounts: {
        key: ['provider', 'provider_user_id'],
        columns: [
            'provider', 'provider_user_id', 'user_id', 'provider_username',
            'provider_avatar_url', 'created_at', 'updated_at'
        ]
    },
    sessions: {
        key: ['token_hash'],
        sensitiveKey: true,
        columns: ['token_hash', 'user_id', 'expires_at', 'created_at']
    },
    oauth_states: {
        key: ['state_hash'],
        sensitiveKey: true,
        columns: [
            'state_hash', 'provider', 'code_verifier', 'linking_user_id',
            'expires_at', 'created_at'
        ]
    },
    email_credentials: {
        key: ['email'],
        columns: [
            'email', 'user_id', 'password_hash', 'salt', 'created_at', 'updated_at'
        ]
    },
    offices: {
        key: ['id'],
        columns: [
            'id', 'slug', 'owner_id', 'name', 'intro', 'city', 'address',
            'latitude', 'longitude', 'accent', 'cover_image', 'is_open',
            'visitor_count', 'created_at', 'archived_at', 'updated_at'
        ]
    },
    series_tags: { key: ['name'], columns: ['name'] },
    office_series_tags: {
        key: ['office_id', 'series_tag'],
        columns: ['office_id', 'series_tag', 'sort_order']
    },
    cards: {
        key: ['id'],
        columns: [
            'id', 'owner_id', 'producer_name', 'display_name', 'series',
            'favorite_idol', 'front_image', 'back_image', 'accent', 'bio',
            'trade_note', 'available', 'created_at', 'source_url',
            'source_label', 'source_credit'
        ]
    },
    office_cards: {
        key: ['office_id', 'card_id'],
        columns: [
            'office_id', 'card_id', 'pinned_at', 'position_x', 'position_y',
            'rotation', 'z_index'
        ]
    },
    messages: {
        key: ['id'],
        columns: ['id', 'office_id', 'author_id', 'content', 'created_at']
    },
    exchange_requests: {
        key: ['id'],
        columns: [
            'id', 'office_id', 'requester_id', 'recipient_id', 'wanted_card_id',
            'offered_card_id', 'note', 'status', 'created_at', 'updated_at'
        ]
    },
    card_likes: {
        key: ['card_id', 'user_id'],
        columns: ['card_id', 'user_id', 'created_at']
    },
    card_favorites: {
        key: ['card_id', 'user_id'],
        columns: ['card_id', 'user_id', 'created_at']
    }
};
const IMPORT_TABLE_ORDER = [
    'users', 'email_credentials', 'oauth_accounts', 'offices', 'series_tags', 'cards',
    'office_series_tags', 'office_cards', 'messages', 'exchange_requests',
    'card_likes', 'card_favorites'
];
const NON_IMPORTED_TABLES = new Set(['sessions', 'oauth_states']);
const ALLOWED_D1_INTERNAL_TABLES = new Set(['d1_migrations']);
const SOURCE_COLUMN_DEFAULTS = new Map([
    ['users.created_at', 'CURRENT_TIMESTAMP'],
    ['users.bio', "''"],
    ['oauth_accounts.created_at', 'CURRENT_TIMESTAMP'],
    ['oauth_accounts.updated_at', 'CURRENT_TIMESTAMP'],
    ['sessions.created_at', 'CURRENT_TIMESTAMP'],
    ['oauth_states.created_at', 'CURRENT_TIMESTAMP'],
    ['email_credentials.created_at', 'CURRENT_TIMESTAMP'],
    ['email_credentials.updated_at', 'CURRENT_TIMESTAMP'],
    ['offices.accent', "'#ef5b6c'"],
    ['offices.is_open', '1'],
    ['offices.visitor_count', '0'],
    ['offices.created_at', 'CURRENT_TIMESTAMP'],
    ['office_series_tags.sort_order', '0'],
    ['cards.accent', "'#4f64dd'"],
    ['cards.available', '1'],
    ['cards.created_at', 'CURRENT_TIMESTAMP'],
    ['office_cards.pinned_at', 'CURRENT_TIMESTAMP'],
    ['office_cards.position_x', '50'],
    ['office_cards.position_y', '50'],
    ['office_cards.rotation', '0'],
    ['office_cards.z_index', '1'],
    ['messages.created_at', 'CURRENT_TIMESTAMP'],
    ['exchange_requests.note', "''"],
    ['exchange_requests.status', "'pending'"],
    ['exchange_requests.created_at', 'CURRENT_TIMESTAMP'],
    ['exchange_requests.updated_at', 'CURRENT_TIMESTAMP'],
    ['card_likes.created_at', 'CURRENT_TIMESTAMP'],
    ['card_favorites.created_at', 'CURRENT_TIMESTAMP']
]);
const SOURCE_INDEX_SQL = new Map([
    ['card_favorites_user_idx',
        'CREATE INDEX card_favorites_user_idx ON card_favorites(user_id, created_at DESC)'],
    ['card_likes_user_idx',
        'CREATE INDEX card_likes_user_idx ON card_likes(user_id, created_at DESC)'],
    ['email_credentials_user_idx',
        'CREATE INDEX email_credentials_user_idx ON email_credentials(user_id)'],
    ['exchange_recipient_idx',
        'CREATE INDEX exchange_recipient_idx ON exchange_requests(recipient_id, status, created_at DESC)'],
    ['exchange_requester_idx',
        'CREATE INDEX exchange_requester_idx ON exchange_requests(requester_id, status, created_at DESC)'],
    ['messages_office_idx',
        'CREATE INDEX messages_office_idx ON messages(office_id, created_at DESC)'],
    ['oauth_accounts_user_idx',
        'CREATE INDEX oauth_accounts_user_idx ON oauth_accounts(user_id)'],
    ['oauth_states_expiry_idx',
        'CREATE INDEX oauth_states_expiry_idx ON oauth_states(expires_at)'],
    ['office_cards_office_idx',
        'CREATE INDEX office_cards_office_idx ON office_cards(office_id, pinned_at DESC)'],
    ['office_cards_wall_order_idx',
        'CREATE INDEX office_cards_wall_order_idx ON office_cards(office_id, z_index DESC)'],
    ['office_series_tags_series_idx',
        'CREATE INDEX office_series_tags_series_idx ON office_series_tags(series_tag, office_id)'],
    ['offices_city_idx', 'CREATE INDEX offices_city_idx ON offices(city)'],
    ['offices_coordinates_idx',
        'CREATE INDEX offices_coordinates_idx ON offices(latitude, longitude)'],
    ['offices_public_idx',
        'CREATE INDEX offices_public_idx ON offices(archived_at, visitor_count DESC)'],
    ['sessions_expiry_idx', 'CREATE INDEX sessions_expiry_idx ON sessions(expires_at)'],
    ['sessions_user_idx', 'CREATE INDEX sessions_user_idx ON sessions(user_id)']
]);
const SOURCE_TABLE_SQL_SHA256 = new Map([
    ['card_favorites', 'c2d9fb71ddfb5e973b34cde9d88ac4fb2a1f1a1e6186e8e9da7c3054ce9b28cb'],
    ['card_likes', '1a6bbb78a3bf4f0c6c35dc4bf30d4360c8fd9938839a853a623c41b151c7deff'],
    ['cards', '04e3d7ce4e5f9938eda7a2318dc280f247782e079ef0ae91ef602ad83e9f134b'],
    ['d1_migrations', 'b635b9b3f4e2a717156ba8ba9a77dc0bae47407077a58e8c8c2d924113909e5c'],
    ['email_credentials', 'f63aa9285cb02890422574a6882eb27367c592460ca3a9cfbca2b8a70945e75f'],
    ['exchange_requests', '6f83ad6cb7b1b0ff4c69e859f755902b223e5969fc6cc5ccdd2da917a3e064df'],
    ['messages', '2d37acefaf22ac92076af995085ab3b78060306f36972912d24ff0b873a44adf'],
    ['oauth_accounts', '852dba401f3c770479991cdf2ac9e884a75934868dcd612f5653c63620c46383'],
    ['oauth_states', '40e144eeb015b4203ac822f63243352e0896993592323a8baa6f165664a864ab'],
    ['office_cards', 'f5ed861f98bb262df36f4f2e99ac3d1d4ba25b1dea3989001ae428142b4122d4'],
    ['office_series_tags', '49df569b5bd6f488f1c7eac16ab1d70f28cdbc97d023076af7861ae40927c614'],
    ['offices', 'ceae918f48c721ef183a3d3774ef7256a63662cbf4666cbcb39aafe61ed6b52b'],
    ['series_tags', 'e4f37bc4013605d08ff85365a61718368ebac3f16a839a24adbc51f512ae2103'],
    ['sessions', '328f61103400b61613e94679f886b0decd852c4222b14bb4f21dc6f5818be734'],
    ['users', 'ecc2c0a0bea537f7882dde3e0e51a5110dd1dfca896e47e7932eeaa1baf61f99']
]);
const SOURCE_TRIGGER_SQL_SHA256 = new Map([
    ['exchanges_require_active_insert',
        '3c044d5bf1da3f0c714d797a95c9c3915d5e3d4459a0b288f55cd98573bded22'],
    ['messages_require_active_insert',
        'bf53553c2de4e1f1ded0513227a47628a44bce5792b07d46ae4100c9122bb572'],
    ['office_cards_require_active_insert',
        '349af704e6d1c6859b48270bf2ee503632d4433536bc9b00178ec80e209a0d07'],
    ['office_cards_require_active_update',
        '85696d9eafa854591deb6542f7bb287ad82e52d92cf63c4d69fdf51cdf472018']
]);
const SOURCE_REAL_COLUMNS = new Set([
    'offices.latitude',
    'offices.longitude',
    'office_cards.position_x',
    'office_cards.position_y',
    'office_cards.rotation'
]);
const SOURCE_INTEGER_COLUMNS = new Set([
    'offices.is_open',
    'offices.visitor_count',
    'office_series_tags.sort_order',
    'cards.available',
    'office_cards.z_index'
]);
const SOURCE_NULLABLE_COLUMNS = new Set([
    'users.id',
    'users.home_city',
    'users.updated_at',
    'sessions.token_hash',
    'oauth_states.state_hash',
    'oauth_states.code_verifier',
    'oauth_states.linking_user_id',
    'email_credentials.email',
    'offices.id',
    'offices.archived_at',
    'offices.updated_at',
    'series_tags.name',
    'cards.id',
    'cards.source_url',
    'cards.source_label',
    'cards.source_credit',
    'messages.id',
    'exchange_requests.id',
    'exchange_requests.offered_card_id'
]);
const PG_BIGINT_COLUMNS = new Set([
    'platform_accounts.created_at',
    'platform_accounts.updated_at',
    'fudaba_offices.visitor_count'
]);

function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!value || typeof value !== 'object' || value instanceof Date) return value;
    return Object.fromEntries(
        Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
    );
}

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(filename) {
    const hash = crypto.createHash('sha256');
    const descriptor = fs.openSync(filename, 'r');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
        let bytesRead;
        do {
            bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
            if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
        } while (bytesRead);
    } finally {
        fs.closeSync(descriptor);
    }
    return hash.digest('hex');
}

function canonicalHash(value) {
    return sha256(JSON.stringify(canonicalize(value)));
}

function validateSnapshotId(value) {
    if (typeof value !== 'string' || !SNAPSHOT_ID_PATTERN.test(value)) {
        throw new Error('Snapshot ID must match [A-Za-z0-9][A-Za-z0-9._-]{0,79}');
    }
    return value;
}

function statProof(filename) {
    const stat = fs.lstatSync(filename, { bigint: true });
    return {
        dev: String(stat.dev),
        ino: String(stat.ino),
        size: String(stat.size),
        mtimeNs: String(stat.mtimeNs),
        ctimeNs: String(stat.ctimeNs),
        mode: String(stat.mode)
    };
}

function assertRegularFile(filename, label) {
    const stat = fs.lstatSync(filename);
    if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`${label} must be a regular non-symlink file`);
    }
    return stat;
}

function assertNoSqliteSidecars(filename) {
    for (const suffix of ['-wal', '-shm', '-journal']) {
        if (fs.existsSync(`${filename}${suffix}`)) {
            throw new Error(`SQLite sidecar must be absent: ${filename}${suffix}`);
        }
    }
}

function openSqlite(filename) {
    return new Promise((resolve, reject) => {
        const database = new sqlite3.Database(filename, sqlite3.OPEN_READONLY, (error) => {
            if (error) reject(error);
            else resolve(database);
        });
    });
}

function openSqliteWritable(filename) {
    return new Promise((resolve, reject) => {
        const database = new sqlite3.Database(filename, sqlite3.OPEN_READWRITE, (error) => {
            if (error) reject(error);
            else resolve(database);
        });
    });
}

function sqliteAll(database, sql, parameters = []) {
    return new Promise((resolve, reject) => {
        database.all(sql, parameters, (error, rows) => {
            if (error) reject(error);
            else resolve(rows);
        });
    });
}

function sqliteExec(database, sql) {
    return new Promise((resolve, reject) => {
        database.exec(sql, (error) => error ? reject(error) : resolve());
    });
}

function closeSqlite(database) {
    return new Promise((resolve, reject) => {
        database.close((error) => error ? reject(error) : resolve());
    });
}

function quoteSqliteIdentifier(value) {
    return `"${value.replaceAll('"', '""')}"`;
}

function normalizeSchemaSql(value) {
    const input = String(value || '');
    let output = '';
    let quote = null;
    for (let index = 0; index < input.length; index += 1) {
        const character = input[index];
        if (quote) {
            output += character;
            if (character === quote) {
                if (quote !== ']' && input[index + 1] === quote) {
                    output += input[index + 1];
                    index += 1;
                } else {
                    quote = null;
                }
            }
            continue;
        }
        if (/\s/.test(character)) continue;
        if (character === '\'' || character === '"' || character === '`') {
            quote = character;
        } else if (character === '[') {
            quote = ']';
        }
        output += character.toLowerCase();
    }
    return output;
}

async function validateSourceDatabase(filename) {
    assertRegularFile(filename, 'Fudaba source database');
    assertNoSqliteSidecars(filename);
    const database = await openSqlite(filename);
    try {
        await sqliteAll(database, 'PRAGMA query_only = ON');
        const quickCheck = await sqliteAll(database, 'PRAGMA quick_check');
        if (quickCheck.length !== 1 || quickCheck[0].quick_check !== 'ok') {
            throw new Error(`SQLite quick_check failed: ${JSON.stringify(quickCheck)}`);
        }
        const foreignKeys = await sqliteAll(database, 'PRAGMA foreign_key_check');
        if (foreignKeys.length) {
            throw new Error(`SQLite foreign_key_check found ${foreignKeys.length} violation(s)`);
        }
        const tables = await sqliteAll(
            database,
            "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        );
        const tableNames = new Set(tables.map((row) => row.name));
        const unexpectedTables = [...tableNames].filter(
            (table) => !SOURCE_TABLES[table] && !ALLOWED_D1_INTERNAL_TABLES.has(table)
        );
        if (unexpectedTables.length) {
            throw new Error(`Unexpected Fudaba source table(s): ${unexpectedTables.sort().join(',')}`);
        }
        if (!tableNames.has('d1_migrations')) {
            throw new Error('Missing Fudaba D1 migration ledger: d1_migrations');
        }
        for (const [table, definition] of Object.entries(SOURCE_TABLES)) {
            if (!tableNames.has(table)) throw new Error(`Missing Fudaba source table: ${table}`);
            const columns = await sqliteAll(
                database,
                `PRAGMA table_info(${quoteSqliteIdentifier(table)})`
            );
            const actualNames = columns.map((column) => column.name);
            if (JSON.stringify(actualNames) !== JSON.stringify(definition.columns)) {
                throw new Error(
                    `Unexpected columns for ${table}: expected ${definition.columns.join(',')}; ` +
                    `received ${actualNames.join(',')}`
                );
            }
            for (const column of columns) {
                const identity = `${table}.${column.name}`;
                const expectedType = SOURCE_REAL_COLUMNS.has(identity)
                    ? 'REAL'
                    : SOURCE_INTEGER_COLUMNS.has(identity)
                        ? 'INTEGER'
                        : 'TEXT';
                const expectedNotNull = SOURCE_NULLABLE_COLUMNS.has(identity) ? 0 : 1;
                const expectedPrimaryKey = definition.key.indexOf(column.name) + 1;
                const expectedDefault = SOURCE_COLUMN_DEFAULTS.get(identity) || null;
                if (String(column.type).toUpperCase() !== expectedType ||
                    Number(column.notnull) !== expectedNotNull ||
                    Number(column.pk) !== expectedPrimaryKey ||
                    (column.dflt_value === null ? null : String(column.dflt_value)) !==
                        expectedDefault) {
                    throw new Error(
                        `Unexpected schema for ${identity}: expected ` +
                        `${expectedType}/notnull=${expectedNotNull}/pk=${expectedPrimaryKey}/` +
                        `default=${expectedDefault}`
                    );
                }
            }
        }
        const tableSql = new Map(tables.map((table) => [table.name, table.sql]));
        for (const [table, expectedSha256] of SOURCE_TABLE_SQL_SHA256) {
            const actualSha256 = sha256(normalizeSchemaSql(tableSql.get(table)));
            if (actualSha256 !== expectedSha256) {
                throw new Error(`Fudaba source table DDL drift: ${table}`);
            }
        }
        const ledger = await sqliteAll(database, 'SELECT name FROM d1_migrations ORDER BY id');
        if (JSON.stringify(ledger.map((row) => row.name)) !== JSON.stringify(FUDABA_MIGRATIONS)) {
            throw new Error('Fudaba D1 migration ledger does not match the locked migration list');
        }

        const explicitIndexes = await sqliteAll(database, `
            SELECT name, sql FROM sqlite_master
            WHERE type = 'index' AND sql IS NOT NULL
              AND tbl_name IN (${Object.keys(SOURCE_TABLES).map(() => '?').join(', ')})
            ORDER BY name
        `, Object.keys(SOURCE_TABLES));
        const actualIndexNames = explicitIndexes.map((index) => index.name);
        const expectedIndexNames = [...SOURCE_INDEX_SQL.keys()].sort();
        if (JSON.stringify(actualIndexNames) !== JSON.stringify(expectedIndexNames)) {
            throw new Error('Fudaba source indexes do not match the locked schema');
        }
        for (const index of explicitIndexes) {
            if (normalizeSchemaSql(index.sql) !==
                normalizeSchemaSql(SOURCE_INDEX_SQL.get(index.name))) {
                throw new Error(`Fudaba source index drift: ${index.name}`);
            }
        }

        const triggers = await sqliteAll(database, `
            SELECT name, tbl_name, sql FROM sqlite_master
            WHERE type = 'trigger'
              AND tbl_name IN (${Object.keys(SOURCE_TABLES).map(() => '?').join(', ')})
            ORDER BY name
        `, Object.keys(SOURCE_TABLES));
        if (JSON.stringify(triggers.map((trigger) => trigger.name)) !==
            JSON.stringify([...SOURCE_TRIGGER_SQL_SHA256.keys()].sort())) {
            throw new Error('Fudaba source triggers do not match the locked schema');
        }
        for (const trigger of triggers) {
            const actualSha256 = sha256(normalizeSchemaSql(trigger.sql));
            if (actualSha256 !== SOURCE_TRIGGER_SQL_SHA256.get(trigger.name)) {
                throw new Error(`Fudaba source trigger DDL drift: ${trigger.name}`);
            }
        }
        return { quickCheck: 'ok', foreignKeyViolations: 0 };
    } finally {
        await closeSqlite(database);
    }
}

function sourceManifestKey(table, row) {
    const definition = SOURCE_TABLES[table];
    if (!definition) throw new Error(`Unknown Fudaba source table: ${table}`);
    if (definition.sensitiveKey) {
        return { sha256: sha256(definition.key.map((field) => row[field]).join('\0')) };
    }
    return Object.fromEntries(definition.key.map((field) => [field, row[field]]));
}

function sourceRowIdentity(table, rowOrKey) {
    const key = Object.hasOwn(rowOrKey, 'classification') || Object.hasOwn(rowOrKey, 'rowSha256')
        ? rowOrKey.key
        : sourceManifestKey(table, rowOrKey);
    return `${table}:${JSON.stringify(canonicalize(key))}`;
}

async function readSourceRows(filename) {
    const database = await openSqlite(filename);
    try {
        await sqliteAll(database, 'PRAGMA query_only = ON');
        const output = {};
        for (const [table, definition] of Object.entries(SOURCE_TABLES)) {
            const order = definition.key.map(
                (column) => `CAST(${quoteSqliteIdentifier(column)} AS BLOB)`
            ).join(', ');
            output[table] = await sqliteAll(
                database,
                `SELECT * FROM ${quoteSqliteIdentifier(table)} ORDER BY ${order}`
            );
        }
        return output;
    } finally {
        await closeSqlite(database);
    }
}

async function readOperationalCounts(filename) {
    const database = await openSqlite(filename);
    try {
        await sqliteAll(database, 'PRAGMA query_only = ON');
        const output = {};
        for (const table of NON_IMPORTED_TABLES) {
            const rows = await sqliteAll(
                database,
                `SELECT COUNT(*) AS count FROM ${quoteSqliteIdentifier(table)}`
            );
            output[table] = Number(rows[0].count);
        }
        return output;
    } finally {
        await closeSqlite(database);
    }
}

async function redactOperationalRows(filename) {
    const database = await openSqliteWritable(filename);
    try {
        await sqliteExec(database, `
            PRAGMA foreign_keys = ON;
            PRAGMA secure_delete = ON;
            BEGIN IMMEDIATE;
            DELETE FROM sessions;
            DELETE FROM oauth_states;
            COMMIT;
            VACUUM;
        `);
    } finally {
        await closeSqlite(database);
    }
    assertNoSqliteSidecars(filename);
    const counts = await readOperationalCounts(filename);
    if ([...NON_IMPORTED_TABLES].some((table) => counts[table] !== 0)) {
        throw new Error('Operational authentication rows were not fully redacted');
    }
}

function readJsonFile(filename, label = path.basename(filename)) {
    assertRegularFile(filename, label);
    try {
        return JSON.parse(fs.readFileSync(filename, 'utf8'));
    } catch (error) {
        throw new Error(`Cannot read ${label}: ${error.message}`);
    }
}

function readJsonArtifact(filename, label) {
    assertRegularFile(filename, label);
    try {
        const body = fs.readFileSync(filename);
        return {
            value: JSON.parse(body.toString('utf8')),
            sha256: sha256(body)
        };
    } catch (error) {
        throw new Error(`Cannot read ${label}: ${error.message}`);
    }
}

function writeJsonAtomic(filename, value) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    try {
        fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
            flag: 'wx',
            mode: 0o600
        });
        fs.renameSync(temporary, filename);
        fs.chmodSync(filename, 0o600);
    } finally {
        fs.rmSync(temporary, { force: true });
    }
}

function classificationEntries(input) {
    if (!input) return [];
    if (Array.isArray(input)) return input;
    if (Array.isArray(input.rows)) return input.rows;
    if (input.tables && typeof input.tables === 'object') {
        return Object.entries(input.tables).flatMap(([table, rows]) =>
            Array.isArray(rows) ? rows.map((row) => ({ ...row, table })) : []
        );
    }
    throw new Error('Classification input must contain rows or tables');
}

function classificationIndex(input) {
    const index = new Map();
    for (const entry of classificationEntries(input)) {
        if (!entry || typeof entry.table !== 'string' || !entry.key) {
            throw new Error('Each classification entry requires table and key');
        }
        if (!SOURCE_CLASSIFICATIONS.has(entry.classification)) {
            throw new Error(`Invalid source classification: ${entry.classification}`);
        }
        if (!SOURCE_TABLES[entry.table] || NON_IMPORTED_TABLES.has(entry.table)) {
            throw new Error(`Classification entry targets a non-importable table: ${entry.table}`);
        }
        if (entry.verifiedProductionCount === true &&
            (entry.table !== 'offices' || typeof entry.productionCountEvidence !== 'string' ||
                !entry.productionCountEvidence.trim())) {
            throw new Error(
                'verifiedProductionCount requires non-empty productionCountEvidence for offices'
            );
        }
        const identity = `${entry.table}:${JSON.stringify(canonicalize(entry.key))}`;
        if (index.has(identity)) throw new Error(`Duplicate classification entry: ${identity}`);
        index.set(identity, {
            classification: entry.classification,
            verifiedProductionCount: entry.verifiedProductionCount === true,
            productionCountEvidence: entry.productionCountEvidence,
            verifiedFinalStatus: entry.verifiedFinalStatus === true,
            targetAccountId: entry.targetAccountId
        });
    }
    return index;
}

function buildRowsManifest(
    snapshotId,
    sourceSha256,
    rows,
    classifications = null,
    operationalCounts = null
) {
    const classificationByRow = classificationIndex(classifications);
    const usedClassifications = new Set();
    const tables = {};
    const summary = {
        total: 0,
        operationalRowsExcluded: 0,
        classifications: Object.fromEntries([...SOURCE_CLASSIFICATIONS].map((value) => [value, 0]))
    };
    for (const [table, tableRows] of Object.entries(rows)) {
        if (NON_IMPORTED_TABLES.has(table)) {
            const count = operationalCounts?.[table] ?? tableRows.length;
            if (!Number.isSafeInteger(count) || count < 0) {
                throw new Error(`Invalid operational row count for ${table}`);
            }
            tables[table] = { count, migrated: false, redactedFromSnapshot: true };
            summary.total += count;
            summary.operationalRowsExcluded += count;
            summary.classifications.unknown += count;
            continue;
        }
        tables[table] = tableRows.map((row) => {
            const key = sourceManifestKey(table, row);
            const identity = `${table}:${JSON.stringify(canonicalize(key))}`;
            const selected = classificationByRow.get(identity) || {
                classification: 'unknown',
                verifiedProductionCount: false
            };
            if (classificationByRow.has(identity)) usedClassifications.add(identity);
            summary.total += 1;
            summary.classifications[selected.classification] += 1;
            const descriptor = {
                key,
                rowSha256: canonicalHash(row),
                classification: selected.classification
            };
            if (table === 'offices') {
                descriptor.verifiedProductionCount = selected.verifiedProductionCount;
                if (selected.verifiedProductionCount) {
                    descriptor.productionCountEvidence = selected.productionCountEvidence;
                }
            }
            if (table === 'exchange_requests') {
                descriptor.verifiedFinalStatus = selected.verifiedFinalStatus;
            }
            if (table === 'users' && selected.classification === 'owner-approved-reference') {
                descriptor.targetAccountId = selected.targetAccountId;
            }
            return descriptor;
        });
    }
    const unusedClassifications = [...classificationByRow.keys()].filter(
        (identity) => !usedClassifications.has(identity)
    );
    if (unusedClassifications.length) {
        throw new Error(
            `Classification entries do not match source rows: ${unusedClassifications.join(',')}`
        );
    }
    return {
        schemaVersion: 1,
        snapshotId,
        sourceSha256,
        summary,
        tables
    };
}

function emptyMediaManifest(snapshotId, sourceSha256) {
    return {
        schemaVersion: 2,
        snapshotId,
        sourceSha256,
        version: 1,
        mediaPlanSha256: null,
        sourceInventorySha256: null,
        entries: []
    };
}

function emptyRightsManifest(snapshotId, sourceSha256) {
    return {
        schemaVersion: 2,
        snapshotId,
        sourceSha256,
        version: 1,
        mediaPlanSha256: null,
        approvals: []
    };
}

async function extractSnapshot(options) {
    const snapshotId = validateSnapshotId(options.snapshotId);
    const source = path.resolve(options.source);
    if (options.fudabaCommit !== FUDABA_COMMIT) {
        throw new Error(`Fudaba commit must be ${FUDABA_COMMIT}`);
    }
    for (const [field, value] of [
        ['D1 database ID', options.d1DatabaseId],
        ['R2 bucket', options.r2Bucket],
        ['application version', options.appVersion],
        ['export time', options.exportTime]
    ]) {
        if (typeof value !== 'string' || !value || value !== value.trim()) {
            throw new Error(`${field} is required and must not contain surrounding whitespace`);
        }
    }
    if (options.d1DatabaseId !== FUDABA_D1_DATABASE_ID) {
        throw new Error(`D1 database ID must be ${FUDABA_D1_DATABASE_ID}`);
    }
    if (options.r2Bucket !== FUDABA_R2_BUCKET) {
        throw new Error(`R2 bucket must be ${FUDABA_R2_BUCKET}`);
    }
    const exportTime = parseTimestamp(options.exportTime, 'export time').iso;
    const before = statProof(source);
    await validateSourceDatabase(source);
    if (JSON.stringify(before) !== JSON.stringify(statProof(source))) {
        throw new Error('Fudaba source database changed during validation');
    }
    assertNoSqliteSidecars(source);
    const sourceExportStat = fs.statSync(source);
    const sourceExportSha256 = sha256File(source);

    const snapshotRoot = path.resolve(options.snapshotRoot || DEFAULT_SNAPSHOT_ROOT);
    const snapshotDirectory = path.join(snapshotRoot, snapshotId);
    fs.mkdirSync(snapshotDirectory, { recursive: true });
    const target = path.join(snapshotDirectory, 'database.sqlite');
    const temporary = path.join(
        snapshotDirectory,
        `.database.sqlite.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`
    );
    try {
        fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
        await validateSourceDatabase(temporary);
        if (JSON.stringify(before) !== JSON.stringify(statProof(source))) {
            throw new Error('Fudaba source database changed while copying');
        }
        assertNoSqliteSidecars(source);
        if (sha256File(source) !== sourceExportSha256) {
            throw new Error('Fudaba source database content changed while copying');
        }
        const operationalCounts = await readOperationalCounts(temporary);
        await redactOperationalRows(temporary);
        await validateSourceDatabase(temporary);
        const databaseStat = fs.statSync(temporary);
        const databaseSha256 = sha256File(temporary);
        if (fs.existsSync(target)) {
            assertRegularFile(target, 'Existing snapshot database');
            if (sha256File(target) !== databaseSha256) {
                throw new Error(`Snapshot already exists with different database: ${snapshotId}`);
            }
            fs.rmSync(temporary);
        } else {
            fs.renameSync(temporary, target);
        }
        fs.chmodSync(target, 0o600);
        const sourceJson = {
            schemaVersion: 1,
            snapshotId,
            source: {
                repository: FUDABA_REPOSITORY,
                commit: FUDABA_COMMIT,
                d1DatabaseId: options.d1DatabaseId,
                r2Bucket: options.r2Bucket,
                migrations: FUDABA_MIGRATIONS,
                appVersion: options.appVersion,
                exportedAt: exportTime
            },
            database: { bytes: databaseStat.size, sha256: databaseSha256 },
            sourceExport: {
                bytes: sourceExportStat.size,
                sha256: sourceExportSha256,
                retainedInSnapshot: false
            },
            validation: {
                regularFile: true,
                symlink: false,
                sqliteSidecars: [],
                quickCheck: 'ok',
                foreignKeyViolations: 0,
                schemaCommit: FUDABA_COMMIT,
                migrationLedger: FUDABA_MIGRATIONS,
                operationalRows: Object.fromEntries(
                    [...NON_IMPORTED_TABLES].map((table) => [table, {
                        sourceCount: operationalCounts[table],
                        snapshotCount: 0,
                        redacted: true
                    }])
                )
            }
        };
        let classifications = options.classifications || null;
        if (typeof classifications === 'string') {
            classifications = readJsonFile(path.resolve(classifications), 'classifications');
        } else if (!classifications && fs.existsSync(path.join(snapshotDirectory, 'rows-manifest.json'))) {
            const previous = readJsonFile(
                path.join(snapshotDirectory, 'rows-manifest.json'),
                'existing rows manifest'
            );
            if (previous.sourceSha256 === sourceExportSha256) classifications = previous;
        }
        const rows = await readSourceRows(target);
        const rowsManifest = buildRowsManifest(
            snapshotId,
            sourceExportSha256,
            rows,
            classifications,
            operationalCounts
        );
        const sourceManifestFile = path.join(snapshotDirectory, 'source.json');
        if (fs.existsSync(sourceManifestFile)) {
            const existingSource = readJsonFile(sourceManifestFile, 'existing source manifest');
            if (canonicalHash(existingSource) !== canonicalHash(sourceJson)) {
                throw new Error(`Snapshot metadata is immutable once created: ${snapshotId}`);
            }
        }
        writeJsonAtomic(sourceManifestFile, sourceJson);
        writeJsonAtomic(path.join(snapshotDirectory, 'rows-manifest.json'), rowsManifest);
        for (const [filename, placeholder] of [
            ['media-manifest.json', emptyMediaManifest(snapshotId, sourceExportSha256)],
            ['rights-manifest.json', emptyRightsManifest(snapshotId, sourceExportSha256)],
            ['reconciliation.json', {
                schemaVersion: 1,
                snapshotId,
                sourceSha256: sourceExportSha256,
                status: 'not-run'
            }]
        ]) {
            const output = path.join(snapshotDirectory, filename);
            if (!fs.existsSync(output)) writeJsonAtomic(output, placeholder);
        }
        return { snapshotDirectory, source: sourceJson, rows: rowsManifest.summary };
    } finally {
        fs.rmSync(temporary, { force: true });
    }
}

function parseTimestamp(value, label) {
    if (typeof value !== 'string' || !value || value !== value.trim()) {
        throw new Error(`${label} is missing or invalid`);
    }
    let normalized = value;
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(normalized)) {
        normalized = `${normalized.replace(' ', 'T')}Z`;
    }
    const match = normalized.match(
        /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/
    );
    if (!match) {
        throw new Error(`${label} is not an ISO/SQLite timestamp`);
    }
    const [, year, month, day, hour, minute, second, , zone] = match;
    const calendar = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (calendar.getUTCFullYear() !== Number(year) ||
        calendar.getUTCMonth() + 1 !== Number(month) || calendar.getUTCDate() !== Number(day) ||
        Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) {
        throw new Error(`${label} is invalid`);
    }
    if (zone !== 'Z') {
        const [zoneHour, zoneMinute] = zone.slice(1).split(':').map(Number);
        if (zoneHour > 23 || zoneMinute > 59) throw new Error(`${label} has invalid timezone`);
    }
    const milliseconds = Date.parse(normalized);
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
        throw new Error(`${label} is invalid`);
    }
    return { iso: new Date(milliseconds).toISOString(), milliseconds };
}

function optionalTimestamp(value, label) {
    return value === null || value === undefined
        ? null
        : parseTimestamp(value, label).iso;
}

function normalizeEmail(value) {
    if (typeof value !== 'string') throw new Error('email must be text');
    const normalized = value.trim().toLowerCase();
    const length = [...normalized].length;
    if (length < 3 || length > 320 || !normalized.includes('@')) {
        throw new Error('email is invalid after normalization');
    }
    return normalized;
}

function mapSeries(value) {
    const mapping = SERIES_MAPPINGS.get(value);
    if (!mapping) throw new Error(`Unknown Fudaba series: ${String(value)}`);
    return mapping;
}

function integerBoolean(value, label) {
    if (value !== 0 && value !== 1) throw new Error(`${label} must be 0 or 1`);
    return value === 1;
}

function finiteNumber(value, label) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${label} must be finite`);
    }
    return value;
}

function exactInteger(value, label) {
    if (!Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer`);
    return value;
}

function manifestEntries(manifest, property) {
    if (Array.isArray(manifest?.[property])) return manifest[property];
    if (property === 'approvals' && Array.isArray(manifest?.entries)) return manifest.entries;
    return [];
}

function entityKind(entry) {
    return entry.entityKind || entry.entity_type || entry.entity?.kind;
}

function entityId(entry) {
    return entry.entityId || entry.entity_id || entry.entity?.id;
}

function entitySlot(entry) {
    return entry.slot || entry.entity?.slot;
}

function mediaIdentity(kind, id, slot) {
    return JSON.stringify([kind, id, slot]);
}

function indexManifestEntries(entries, label) {
    const index = new Map();
    for (const entry of entries) {
        const identity = mediaIdentity(entityKind(entry), entityId(entry), entitySlot(entry));
        if (entityKind(entry) === undefined || entityId(entry) === undefined ||
            entitySlot(entry) === undefined || index.has(identity)) {
            throw new Error(`${label} has invalid or duplicate entry: ${identity}`);
        }
        index.set(identity, entry);
    }
    return index;
}

function mediaObjectKey(entry) {
    if (Object.hasOwn(entry, 'logicalObjectKey')) return entry.logicalObjectKey;
    if (Object.hasOwn(entry, 'logical_object_key')) return entry.logical_object_key;
    return entry.targetLogicalKey;
}

function sourceReference(entry) {
    if (Object.hasOwn(entry, 'sourceReference')) return entry.sourceReference;
    return entry.source_reference || entry.sourceUrl || entry.sourceKey;
}

function assertLogicalMediaKey(kind, id, slot, logicalKey) {
    if (typeof id !== 'string' || id === '.' || id === '..' || /[\\/\x00-\x1f\x7f]/.test(id)) {
        throw new Error(`Media entity ID is not a safe object-key segment: ${String(id)}`);
    }
    const bases = {
        'account:avatar': `community/fudaba/accounts/${id}/avatar.`,
        'office:cover': `community/fudaba/offices/${id}/cover.`,
        'card:front': `community/fudaba/cards/${id}/front.`,
        'card:back': `community/fudaba/cards/${id}/back.`
    };
    const base = bases[`${kind}:${slot}`];
    if (!base || typeof logicalKey !== 'string' || !logicalKey.startsWith(base)) {
        throw new Error(`Media key does not match ${kind}/${id}/${slot}`);
    }
    const extension = logicalKey.slice(base.length);
    if (!/^[a-z0-9]{1,10}$/.test(extension)) {
        throw new Error(`Media key has invalid extension: ${logicalKey}`);
    }
}

function resolveMedia(mediaIndex, rightsIndex, kind, id, slot, source, consumed = null) {
    const identity = mediaIdentity(kind, id, slot);
    const media = mediaIndex.get(identity);
    const rights = rightsIndex.get(identity);
    consumed?.add(identity);
    if (!media) throw new Error(`Media is unresolved: ${identity}`);
    if (sourceReference(media) !== source) {
        throw new Error(`Media source mismatch: ${identity}`);
    }
    const logicalKey = mediaObjectKey(media);
    assertLogicalMediaKey(kind, id, slot, logicalKey);
    const state = media.state || media.status || media.writeStatus;
    const digest = media.sha256 || media.sourceSha256;
    const readback = media.readbackSha256 || media.readback_sha256;
    const binding = media.bindingSha256;
    const expectedExtension = {
        'image/avif': 'avif',
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/webp': 'webp'
    }[media.contentType];
    if (state !== 'ready' || media.disposition !== 'store-protected' ||
        media.storageScope !== 'private' ||
        typeof media.targetBucket !== 'string' || !media.targetBucket ||
        typeof media.objectId !== 'string' || !media.objectId ||
        typeof media.physicalObjectKey !== 'string' || !media.physicalObjectKey ||
        !/(^|\/)__protected\//.test(media.physicalObjectKey) ||
        typeof media.targetEtag !== 'string' || !media.targetEtag ||
        !Number.isSafeInteger(media.bytes) || media.bytes < 1 ||
        !expectedExtension || !logicalKey.endsWith(`.${expectedExtension}`) ||
        !SHA256_PATTERN.test(binding || '') ||
        !SHA256_PATTERN.test(digest || '') || digest !== readback) {
        throw new Error(`Media is not verified ready: ${identity}`);
    }
    const approval = rights?.approvalStatus || rights?.rightsStatus || rights?.status;
    if (approval !== 'approved' || rights?.action !== 'store-protected' ||
        mediaObjectKey(rights) !== logicalKey || rights?.bindingSha256 !== binding ||
        rights?.sourceReference !== source || rights?.sourceSha256 !== digest ||
        rights?.bytes !== media.bytes || rights?.contentType !== media.contentType ||
        !SHA256_PATTERN.test(rights?.evidenceSha256 || '') ||
        typeof rights?.reviewedBy !== 'string' || !rights.reviewedBy.trim() ||
        parseTimestamp(rights?.reviewedAt, 'media rights reviewedAt').milliseconds < 0) {
        throw new Error(`Media rights are not approved: ${identity}`);
    }
    return logicalKey;
}

function resolveOptionalMedia(
    mediaIndex,
    rightsIndex,
    kind,
    id,
    slot,
    source,
    allowExternal = false,
    consumed = null
) {
    const identity = mediaIdentity(kind, id, slot);
    const media = mediaIndex.get(identity);
    const rights = rightsIndex.get(identity);
    consumed?.add(identity);
    if (!media || !rights || sourceReference(media) !== source ||
        rights.sourceReference !== source ||
        !SHA256_PATTERN.test(media.bindingSha256 || '') ||
        rights.bindingSha256 !== media.bindingSha256) {
        throw new Error(`Optional media is unresolved: ${identity}`);
    }
    const state = media.state || media.status || media.writeStatus;
    const approval = rights.approvalStatus || rights.rightsStatus || rights.status;
    if (state === 'omitted' && media.disposition === 'omit' &&
        approval === 'denied' && rights.action === 'omit' &&
        mediaObjectKey(media) === mediaObjectKey(rights) &&
        SHA256_PATTERN.test(rights.evidenceSha256 || '') &&
        typeof rights.reviewedBy === 'string' && rights.reviewedBy.trim()) {
        parseTimestamp(rights.reviewedAt, 'media rights reviewedAt');
        return { externalUrl: null, objectKey: null };
    }
    if (state === 'external' && media.disposition === 'retain-external' &&
        allowExternal && approval === 'approved' && rights.action === 'retain-external' &&
        mediaObjectKey(media) === null && mediaObjectKey(rights) === null &&
        media.externalUrl === source && /^https:\/\//.test(source) &&
        SHA256_PATTERN.test(rights.evidenceSha256 || '') &&
        typeof rights.reviewedBy === 'string' && rights.reviewedBy.trim()) {
        parseTimestamp(rights.reviewedAt, 'media rights reviewedAt');
        return { externalUrl: source, objectKey: null };
    }
    return {
        externalUrl: null,
        objectKey: resolveMedia(
            mediaIndex, rightsIndex, kind, id, slot, source, consumed
        )
    };
}

function targetOperation(
    sourceTable,
    sourceKey,
    table,
    keyColumns,
    row,
    compareColumns = null,
    requiredExisting = false
) {
    return {
        sourceTable,
        sourceKey,
        table,
        keyColumns,
        row,
        compareColumns: compareColumns || Object.keys(row),
        requiredExisting
    };
}

function rowReport(table, descriptor) {
    return {
        sourceTable: table,
        sourceKey: descriptor.key,
        sourceRowSha256: descriptor.rowSha256,
        classification: descriptor.classification,
        outcome: null,
        reasonCode: null,
        reason: null,
        targets: []
    };
}

function targetKey(operation) {
    return Object.fromEntries(operation.keyColumns.map((field) => [field, operation.row[field]]));
}

function targetIdentity(operation) {
    return `${operation.table}:${JSON.stringify(canonicalize(targetKey(operation)))}`;
}

function assertText(value, label, minimum, maximum, trimmed = false) {
    const length = typeof value === 'string' ? [...value].length : -1;
    const trimmedLength = typeof value === 'string' ? [...value.trim()].length : -1;
    if (length < minimum || length > maximum || (trimmed && trimmedLength < minimum)) {
        throw new Error(`${label} length is outside ${minimum}..${maximum}`);
    }
}

function assertChronology(createdAt, updatedAt, label) {
    if (Date.parse(updatedAt) < Date.parse(createdAt)) {
        throw new Error(`${label} updated_at precedes created_at`);
    }
}

function validateTargetOperation(operation) {
    const row = operation.row;
    switch (operation.table) {
    case 'platform_accounts':
        assertText(row.id, 'platform account id', 1, 128);
        if (operation.requiredExisting) break;
        if (BigInt(row.updated_at) < BigInt(row.created_at)) {
            throw new Error('platform account updated_at precedes created_at');
        }
        break;
    case 'platform_profiles':
        assertText(row.account_id, 'profile account id', 1, 128);
        assertText(row.display_name, 'profile display_name', 1, 80, true);
        if (row.avatar_object_key !== null) {
            assertText(row.avatar_object_key, 'profile avatar object key', 1, 1024);
        }
        if (row.avatar_external_url !== null) {
            assertText(row.avatar_external_url, 'profile avatar external URL', 1, 2048);
        }
        if (row.avatar_object_key !== null && row.avatar_external_url !== null) {
            throw new Error('profile cannot have both avatar object key and external URL');
        }
        if (row.home_city !== null) assertText(row.home_city, 'profile home_city', 0, 100);
        assertText(row.bio, 'profile bio', 0, 2000);
        break;
    case 'platform_oauth_identities':
        assertText(row.account_id, 'OAuth account id', 1, 128);
        assertText(row.provider_subject, 'provider subject', 1, 512);
        assertText(row.provider_display_name, 'provider display name', 0, 200);
        assertText(row.provider_avatar_url, 'provider avatar URL', 0, 2048);
        if (BigInt(row.updated_at) < BigInt(row.created_at)) {
            throw new Error('OAuth identity updated_at precedes created_at');
        }
        break;
    case 'platform_email_credentials':
        assertText(row.account_id, 'credential account id', 1, 128);
        if (!/^[a-f0-9]{64}$/.test(row.password_hash)) {
            throw new Error('PBKDF2 password hash must be 32-byte lowercase hex');
        }
        assertText(row.salt, 'credential salt', 1, 1024);
        if (BigInt(row.updated_at) < BigInt(row.created_at)) {
            throw new Error('email credential updated_at precedes created_at');
        }
        break;
    case 'fudaba_offices':
        assertText(row.id, 'office id', 1, 128);
        assertText(row.owner_account_id, 'office owner id', 1, 128);
        assertText(row.slug, 'office slug', 1, 120);
        if (!/^[a-z0-9一-龥]+(?:-[a-z0-9一-龥]+)*$/.test(row.slug)) {
            throw new Error('office slug is invalid');
        }
        assertText(row.name, 'office name', 1, 80, true);
        assertText(row.intro, 'office intro', 0, 2000);
        assertText(row.city, 'office city', 1, 100, true);
        assertText(row.address, 'office address', 1, 240, true);
        if (row.latitude < -90 || row.latitude > 90 ||
            row.longitude < -180 || row.longitude > 180) {
            throw new Error('office coordinates are outside valid range');
        }
        if (!/^#[0-9A-Fa-f]{6}$/.test(row.accent)) throw new Error('office accent is invalid');
        if (row.cover_object_key !== null) {
            assertText(row.cover_object_key, 'office cover object key', 1, 1024);
        }
        if (row.pending_cover_object_key !== null ||
            row.pending_cover_submitted_at !== null) {
            throw new Error('imported office cannot carry a pending cover');
        }
        if (BigInt(row.visitor_count) < 0n || BigInt(row.visitor_count) > 9007199254740991n) {
            throw new Error('office visitor_count is outside valid range');
        }
        assertChronology(row.created_at, row.updated_at, 'office');
        if (row.archived_at && Date.parse(row.archived_at) < Date.parse(row.created_at)) {
            throw new Error('office archived_at precedes created_at');
        }
        break;
    case 'agencies':
        assertText(row.code, 'agency code', 1, 40);
        break;
    case 'fudaba_cards':
        assertText(row.id, 'card id', 1, 128);
        assertText(row.owner_account_id, 'card owner id', 1, 128);
        assertText(row.producer_name, 'card producer_name', 1, 80, true);
        assertText(row.display_name, 'card display_name', 1, 120, true);
        assertText(row.favorite_idol, 'card favorite_idol', 0, 200);
        assertText(row.bio, 'card bio', 0, 2000);
        assertText(row.trade_note, 'card trade_note', 0, 1000);
        assertText(row.front_object_key, 'card front object key', 1, 1024);
        assertText(row.back_object_key, 'card back object key', 1, 1024);
        if (!/^#[0-9A-Fa-f]{6}$/.test(row.accent)) throw new Error('card accent is invalid');
        if (row.front_object_key === row.back_object_key) {
            throw new Error('card front and back object keys must differ');
        }
        if (row.source_url !== null &&
            (typeof row.source_url !== 'string' || !/^https?:\/\//.test(row.source_url) ||
                row.source_url.length > 2048)) {
            throw new Error('card source_url is invalid');
        }
        if (row.source_label !== null) assertText(row.source_label, 'source label', 0, 200);
        if (row.source_credit !== null) assertText(row.source_credit, 'source credit', 0, 200);
        assertChronology(row.created_at, row.updated_at, 'card');
        break;
    case 'fudaba_office_series_tags':
        assertText(row.office_id, 'office series office id', 1, 128);
        assertText(row.series_code, 'office series code', 1, 40);
        if (row.display_order < 0) throw new Error('office series display_order is negative');
        break;
    case 'fudaba_office_cards':
        assertText(row.office_id, 'office card office id', 1, 128);
        assertText(row.card_id, 'office card card id', 1, 128);
        if (row.position_x < 0 || row.position_x > 100 ||
            row.position_y < 0 || row.position_y > 100 ||
            row.rotation < -12 || row.rotation > 12 ||
            row.z_index < 1 || row.z_index > 999) {
            throw new Error('office card placement is outside target constraints');
        }
        if (row.revision !== 0 || row.updated_at !== row.pinned_at) {
            throw new Error('imported office card has invalid initial revision');
        }
        break;
    case 'fudaba_messages':
        assertText(row.id, 'message id', 1, 128);
        assertText(row.office_id, 'message office id', 1, 128);
        assertText(row.author_account_id, 'message author id', 1, 128);
        assertText(row.content, 'message content', 1, 280, true);
        if (row.hidden_at !== null || row.hidden_by_account_id !== null) {
            throw new Error('imported message cannot be hidden');
        }
        break;
    case 'fudaba_exchange_requests':
        assertText(row.id, 'exchange id', 1, 128);
        assertText(row.office_id, 'exchange office id', 1, 128);
        assertText(row.requester_account_id, 'exchange requester id', 1, 128);
        assertText(row.recipient_account_id, 'exchange recipient id', 1, 128);
        assertText(row.wanted_card_id, 'exchange wanted card id', 1, 128);
        if (row.offered_card_id !== null) {
            assertText(row.offered_card_id, 'exchange offered card id', 1, 128);
        }
        assertText(row.note, 'exchange note', 0, 1000);
        if (row.requester_account_id === row.recipient_account_id) {
            throw new Error('exchange requester and recipient are identical');
        }
        if (row.offered_card_id === row.wanted_card_id) {
            throw new Error('exchange offered and wanted cards are identical');
        }
        assertChronology(row.created_at, row.updated_at, 'exchange');
        break;
    case 'fudaba_card_likes':
    case 'fudaba_card_favorites':
        assertText(row.card_id, 'interaction card id', 1, 128);
        assertText(row.account_id, 'interaction account id', 1, 128);
        break;
    }
}

function verifyArtifactIdentity(manifest, sourceJson, label) {
    if (manifest.snapshotId !== sourceJson.snapshotId ||
        manifest.sourceSha256 !== sourceJson.sourceExport.sha256) {
        throw new Error(`${label} does not belong to this snapshot`);
    }
}

function verifyMediaPlan(
    planArtifact,
    sourceJson,
    mediaManifest,
    rightsManifest
) {
    const plan = planArtifact.value;
    if (plan.schemaVersion !== 2 || plan.sourceCommit !== FUDABA_COMMIT ||
        plan.sourceBucket !== FUDABA_R2_BUCKET ||
        plan.sourceInventorySha256 !== mediaManifest.sourceInventorySha256 ||
        planArtifact.sha256 !== mediaManifest.mediaPlanSha256 ||
        planArtifact.sha256 !== rightsManifest.mediaPlanSha256 ||
        !Array.isArray(plan.entries)) {
        throw new Error('media plan identity or artifact SHA-256 is invalid');
    }
    verifyArtifactIdentity(plan, sourceJson, 'media plan');
    for (const entry of plan.entries) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
            !SHA256_PATTERN.test(entry.bindingSha256 || '')) {
            throw new Error('media plan has an invalid binding SHA-256');
        }
        const { bindingSha256, ...bound } = entry;
        if (canonicalHash(bound) !== bindingSha256) {
            throw new Error(
                `media plan binding SHA-256 is invalid: ` +
                mediaIdentity(entityKind(entry), entityId(entry), entitySlot(entry))
            );
        }
    }
    const planEntries = indexManifestEntries(plan.entries, 'media plan');
    for (const [manifest, property, label] of [
        [mediaManifest, 'entries', 'media manifest'],
        [rightsManifest, 'approvals', 'rights manifest']
    ]) {
        const entries = indexManifestEntries(manifestEntries(manifest, property), label);
        if (entries.size !== planEntries.size) {
            throw new Error(`${label} entry count does not match the media plan`);
        }
        for (const [identity, planned] of planEntries) {
            const entry = entries.get(identity);
            if (!entry || entry.bindingSha256 !== planned.bindingSha256 ||
                sourceReference(entry) !== sourceReference(planned) ||
                mediaObjectKey(entry) !== mediaObjectKey(planned)) {
                throw new Error(`${label} entry does not match the media plan: ${identity}`);
            }
        }
    }
    return plan;
}

async function loadSnapshot(snapshotDirectory) {
    const directory = path.resolve(snapshotDirectory);
    const sourceArtifact = readJsonArtifact(
        path.join(directory, 'source.json'),
        'source manifest'
    );
    const sourceJson = sourceArtifact.value;
    validateSnapshotId(sourceJson.snapshotId);
    if (sourceJson.schemaVersion !== 1 || sourceJson.source?.commit !== FUDABA_COMMIT ||
        JSON.stringify(sourceJson.source?.migrations) !== JSON.stringify(FUDABA_MIGRATIONS)) {
        throw new Error('Source manifest does not match the locked Fudaba commit/migrations');
    }
    if (sourceJson.source?.d1DatabaseId !== FUDABA_D1_DATABASE_ID ||
        sourceJson.source?.r2Bucket !== FUDABA_R2_BUCKET ||
        !SHA256_PATTERN.test(sourceJson.sourceExport?.sha256 || '') ||
        !Number.isSafeInteger(sourceJson.sourceExport?.bytes) ||
        sourceJson.sourceExport.bytes < 1 ||
        sourceJson.sourceExport.retainedInSnapshot !== false) {
        throw new Error('Source manifest provenance is incomplete or invalid');
    }
    const databaseFile = path.join(directory, 'database.sqlite');
    const stat = assertRegularFile(databaseFile, 'Snapshot database');
    assertNoSqliteSidecars(databaseFile);
    const databaseSha256 = sha256File(databaseFile);
    if (sourceJson.database?.sha256 !== databaseSha256 ||
        sourceJson.database?.bytes !== stat.size) {
        throw new Error('Snapshot database size or SHA-256 does not match source.json');
    }
    await validateSourceDatabase(databaseFile);
    const rowsArtifact = readJsonArtifact(
        path.join(directory, 'rows-manifest.json'),
        'rows manifest'
    );
    const mediaArtifact = readJsonArtifact(
        path.join(directory, 'media-manifest.json'),
        'media manifest'
    );
    const rightsArtifact = readJsonArtifact(
        path.join(directory, 'rights-manifest.json'),
        'rights manifest'
    );
    const rowsManifest = rowsArtifact.value;
    const mediaManifest = mediaArtifact.value;
    const rightsManifest = rightsArtifact.value;
    if (rowsManifest.schemaVersion !== 1) {
        throw new Error('rows manifest has unsupported schemaVersion');
    }
    if (mediaManifest.schemaVersion !== 2 || rightsManifest.schemaVersion !== 2) {
        throw new Error('media and rights manifests must use schemaVersion 2');
    }
    for (const [manifest, label] of [
        [rowsManifest, 'rows manifest'],
        [mediaManifest, 'media manifest'],
        [rightsManifest, 'rights manifest']
    ]) verifyArtifactIdentity(manifest, sourceJson, label);
    const mediaEntries = manifestEntries(mediaManifest, 'entries');
    const rightsApprovals = manifestEntries(rightsManifest, 'approvals');
    const hasMediaPlan = mediaManifest.mediaPlanSha256 !== null ||
        rightsManifest.mediaPlanSha256 !== null;
    let mediaPlanArtifact = null;
    let mediaPlan = null;
    if (mediaEntries.length || rightsApprovals.length || hasMediaPlan) {
        if (!SHA256_PATTERN.test(mediaManifest.mediaPlanSha256 || '') ||
            mediaManifest.mediaPlanSha256 !== rightsManifest.mediaPlanSha256 ||
            !SHA256_PATTERN.test(mediaManifest.sourceInventorySha256 || '')) {
            throw new Error('media and rights manifests are not bound to one verified media plan');
        }
        mediaPlanArtifact = readJsonArtifact(
            path.join(directory, 'media-plan.json'),
            'media plan'
        );
        mediaPlan = verifyMediaPlan(
            mediaPlanArtifact,
            sourceJson,
            mediaManifest,
            rightsManifest
        );
    }
    const rows = await readSourceRows(databaseFile);
    for (const table of NON_IMPORTED_TABLES) {
        if (rows[table].length !== 0) {
            throw new Error(`Snapshot database retains operational authentication rows: ${table}`);
        }
        const validation = sourceJson.validation?.operationalRows?.[table];
        const manifest = rowsManifest.tables?.[table];
        if (!validation || !Number.isSafeInteger(validation.sourceCount) ||
            validation.sourceCount < 0 || validation.snapshotCount !== 0 ||
            validation.redacted !== true || !manifest ||
            manifest.count !== validation.sourceCount || manifest.migrated !== false ||
            manifest.redactedFromSnapshot !== true) {
            throw new Error(`Operational row provenance mismatch for ${table}`);
        }
    }
    return {
        directory,
        databaseFile,
        sourceJson,
        rowsManifest,
        mediaPlan,
        mediaManifest,
        rightsManifest,
        artifactSha256: {
            source: sourceArtifact.sha256,
            rows: rowsArtifact.sha256,
            mediaPlan: mediaPlanArtifact?.sha256 || null,
            media: mediaArtifact.sha256,
            rights: rightsArtifact.sha256
        },
        rows
    };
}

function descriptorIndex(rowsManifest) {
    if (rowsManifest.schemaVersion !== 1 || !rowsManifest.tables ||
        typeof rowsManifest.tables !== 'object' || Array.isArray(rowsManifest.tables)) {
        throw new Error('Invalid rows manifest');
    }
    const manifestTables = Object.keys(rowsManifest.tables);
    const unexpectedTables = manifestTables.filter((table) => !SOURCE_TABLES[table]);
    const missingTables = Object.keys(SOURCE_TABLES).filter(
        (table) => !Object.hasOwn(rowsManifest.tables, table)
    );
    if (unexpectedTables.length || missingTables.length) {
        throw new Error(
            `Rows manifest table mismatch; missing=${missingTables.join(',')}; ` +
            `unexpected=${unexpectedTables.join(',')}`
        );
    }
    const index = new Map();
    for (const [table, rows] of Object.entries(rowsManifest.tables || {})) {
        if (NON_IMPORTED_TABLES.has(table) && rows && Number.isSafeInteger(rows.count) &&
            rows.count >= 0 && rows.migrated === false) continue;
        if (!SOURCE_TABLES[table] || !Array.isArray(rows)) {
            throw new Error(`Invalid rows manifest table: ${table}`);
        }
        for (const descriptor of rows) {
            if (!SOURCE_CLASSIFICATIONS.has(descriptor.classification)) {
                throw new Error(`Invalid classification in rows manifest: ${descriptor.classification}`);
            }
            if (table === 'offices' && descriptor.verifiedProductionCount === true &&
                (typeof descriptor.productionCountEvidence !== 'string' ||
                    !descriptor.productionCountEvidence.trim())) {
                throw new Error('Verified office visitor count is missing evidence');
            }
            const identity = `${table}:${JSON.stringify(canonicalize(descriptor.key))}`;
            if (index.has(identity)) throw new Error(`Duplicate rows manifest entry: ${identity}`);
            index.set(identity, descriptor);
        }
    }
    return index;
}

function operationForRow(table, row, descriptor, context) {
    const sourceKey = descriptor.key;
    const created = table === 'series_tags'
        ? context.exportedAt
        : Object.hasOwn(row, 'created_at')
            ? parseTimestamp(row.created_at, `${table} created_at`)
            : null;
    switch (table) {
    case 'users': {
        const targetAccountId = context.accountId(row.id);
        if (descriptor.classification === 'owner-approved-reference') {
            return [targetOperation(table, sourceKey, 'platform_accounts', ['id'], {
                id: targetAccountId
            }, ['id'], true)];
        }
        const updated = row.updated_at === null || row.updated_at === undefined
            ? created
            : parseTimestamp(row.updated_at, 'users updated_at');
        const avatar = row.avatar_url === ''
            ? { externalUrl: null, objectKey: null }
            : resolveOptionalMedia(
                context.mediaIndex,
                context.rightsIndex,
                'account',
                row.id,
                'avatar',
                row.avatar_url,
                true,
                context.consumedMedia
            );
        return [
            targetOperation(table, sourceKey, 'platform_accounts', ['id'], {
                id: row.id,
                status: 'active',
                token_version: 0,
                created_at: String(created.milliseconds),
                updated_at: String(updated.milliseconds),
                deleted_at: null
            }),
            targetOperation(table, sourceKey, 'platform_profiles', ['account_id'], {
                account_id: row.id,
                display_name: row.display_name,
                avatar_object_key: avatar.objectKey,
                avatar_external_url: avatar.externalUrl,
                home_city: row.home_city,
                bio: row.bio,
                updated_at: String(updated.milliseconds)
            })
        ];
    }
    case 'oauth_accounts':
        if (!['google', 'github'].includes(row.provider)) {
            throw new Error(`Unknown OAuth provider: ${row.provider}`);
        }
        if (context.isReferenceAccount(row.user_id)) {
            throw new Error('owner-approved-reference OAuth identity must not be imported');
        }
        context.requireIncluded('users', row.user_id);
        return [targetOperation(table, sourceKey, 'platform_oauth_identities', [
            'provider_code', 'provider_subject'
        ], {
            provider_code: row.provider,
            provider_subject: row.provider_user_id,
            account_id: context.accountId(row.user_id),
            provider_display_name: row.provider_username,
            provider_avatar_url: row.provider_avatar_url,
            created_at: String(created.milliseconds),
            updated_at: String(parseTimestamp(row.updated_at, 'oauth_accounts updated_at').milliseconds)
        })];
    case 'email_credentials':
        if (context.isReferenceAccount(row.user_id)) {
            throw new Error('owner-approved-reference credential must not be imported');
        }
        context.requireIncluded('users', row.user_id);
        return [targetOperation(table, sourceKey, 'platform_email_credentials', [
            'normalized_email'
        ], {
            normalized_email: normalizeEmail(row.email),
            account_id: context.accountId(row.user_id),
            algorithm: 'pbkdf2-sha256',
            parameters_json: JSON.stringify({
                iterations: 100000,
                hash: 'sha256',
                keyLength: 32,
                encoding: 'hex',
                saltEncoding: 'utf8'
            }),
            salt: row.salt,
            password_hash: row.password_hash,
            created_at: String(created.milliseconds),
            updated_at: String(parseTimestamp(row.updated_at, 'email_credentials updated_at').milliseconds)
        })];
    case 'offices': {
        context.requireIncluded('users', row.owner_id);
        const archived = optionalTimestamp(row.archived_at, 'offices archived_at');
        const sourceVisitorCount = exactInteger(
            row.visitor_count,
            'offices visitor_count'
        );
        if (sourceVisitorCount < 0 || sourceVisitorCount > Number.MAX_SAFE_INTEGER) {
            throw new Error('offices visitor_count is outside valid range');
        }
        if (descriptor.verifiedProductionCount === true &&
            (typeof descriptor.productionCountEvidence !== 'string' ||
                !descriptor.productionCountEvidence.trim())) {
            throw new Error('verified visitor count requires productionCountEvidence');
        }
        const visitorCount = descriptor.verifiedProductionCount === true
            ? sourceVisitorCount
            : 0;
        context.reportsByIdentity.get(sourceRowIdentity(table, row)).visitorCount = {
            source: sourceVisitorCount,
            imported: visitorCount,
            verifiedProductionCount: descriptor.verifiedProductionCount === true,
            evidence: descriptor.productionCountEvidence || null
        };
        const updated = row.updated_at === null || row.updated_at === undefined
            ? created.iso
            : parseTimestamp(row.updated_at, 'offices updated_at').iso;
        const operation = targetOperation(table, sourceKey, 'fudaba_offices', ['id'], {
            id: row.id,
            owner_account_id: context.accountId(row.owner_id),
            slug: row.slug,
            name: row.name,
            intro: row.intro,
            city: row.city,
            address: row.address,
            latitude: finiteNumber(row.latitude, 'offices latitude'),
            longitude: finiteNumber(row.longitude, 'offices longitude'),
            accent: row.accent,
            cover_object_key: row.cover_image === ''
                ? null
                : resolveOptionalMedia(
                    context.mediaIndex,
                    context.rightsIndex,
                    'office',
                    row.id,
                    'cover',
                    row.cover_image,
                    false,
                    context.consumedMedia
                ).objectKey,
            pending_cover_object_key: null,
            pending_cover_submitted_at: null,
            is_open: integerBoolean(row.is_open, 'offices is_open'),
            visitor_count: String(visitorCount),
            status: archived ? 'archived' : 'active',
            revision: 0,
            created_at: created.iso,
            updated_at: updated,
            archived_at: archived
        });
        if (archived) {
            operation.stagedRow = {
                ...operation.row,
                status: 'active',
                archived_at: null
            };
        }
        return [operation];
    }
    case 'series_tags': {
        const mapping = mapSeries(row.name);
        if (mapping.code === null) return [];
        return [targetOperation(
            table,
            sourceKey,
            'agencies',
            ['code'],
            { code: mapping.code },
            ['code'],
            true
        )];
    }
    case 'cards': {
        context.requireIncluded('users', row.owner_id);
        const mapping = mapSeries(row.series);
        if (mapping.code === null) {
            throw new Error(
                'FUDABA_VALIV_AGENCY_RECONCILIATION_REQUIRED: ' +
                'vα-liv is not 876PRO and cannot be mapped automatically'
            );
        }
        context.requireIncluded('series_tags', row.series);
        return [targetOperation(table, sourceKey, 'fudaba_cards', ['id'], {
            id: row.id,
            owner_account_id: context.accountId(row.owner_id),
            producer_name: row.producer_name,
            display_name: row.display_name,
            series_code: mapping.code,
            favorite_idol: row.favorite_idol,
            front_object_key: resolveMedia(
                context.mediaIndex, context.rightsIndex, 'card', row.id, 'front',
                row.front_image, context.consumedMedia
            ),
            back_object_key: resolveMedia(
                context.mediaIndex, context.rightsIndex, 'card', row.id, 'back',
                row.back_image, context.consumedMedia
            ),
            accent: row.accent,
            bio: row.bio,
            trade_note: row.trade_note,
            available: integerBoolean(row.available, 'cards available'),
            source_url: row.source_url,
            source_label: row.source_label,
            source_credit: row.source_credit,
            media_rights_status: 'approved',
            publication_status: 'draft',
            revision: 0,
            created_at: created.iso,
            updated_at: created.iso,
            deleted_at: null
        })];
    }
    case 'office_series_tags':
        context.requireIncluded('offices', row.office_id);
        context.requireIncluded('series_tags', row.series_tag);
        if (mapSeries(row.series_tag).code === null) {
            throw new Error(
                'FUDABA_VALIV_AGENCY_RECONCILIATION_REQUIRED: ' +
                'vα-liv is not 876PRO and cannot be mapped automatically'
            );
        }
        return [targetOperation(table, sourceKey, 'fudaba_office_series_tags', [
            'office_id', 'series_code'
        ], {
            office_id: row.office_id,
            series_code: mapSeries(row.series_tag).code,
            display_order: exactInteger(row.sort_order, 'office_series_tags sort_order')
        })];
    case 'office_cards': {
        context.requireIncluded('offices', row.office_id);
        context.requireIncluded('cards', row.card_id);
        const pinnedAt = created
            ? created.iso
            : parseTimestamp(row.pinned_at, 'office_cards pinned_at').iso;
        return [targetOperation(table, sourceKey, 'fudaba_office_cards', [
            'office_id', 'card_id'
        ], {
            office_id: row.office_id,
            card_id: row.card_id,
            pinned_at: pinnedAt,
            position_x: finiteNumber(row.position_x, 'office_cards position_x'),
            position_y: finiteNumber(row.position_y, 'office_cards position_y'),
            rotation: finiteNumber(row.rotation, 'office_cards rotation'),
            z_index: exactInteger(row.z_index, 'office_cards z_index'),
            revision: 0,
            updated_at: pinnedAt
        })];
    }
    case 'messages':
        context.requireIncluded('offices', row.office_id);
        context.requireIncluded('users', row.author_id);
        return [targetOperation(table, sourceKey, 'fudaba_messages', ['id'], {
            id: row.id,
            office_id: row.office_id,
            author_account_id: context.accountId(row.author_id),
            content: row.content,
            created_at: created.iso,
            hidden_at: null,
            hidden_by_account_id: null
        })];
    case 'exchange_requests': {
        context.requireIncluded('offices', row.office_id);
        context.requireIncluded('users', row.requester_id);
        context.requireIncluded('users', row.recipient_id);
        context.requireIncluded('cards', row.wanted_card_id);
        if (row.offered_card_id !== null) context.requireIncluded('cards', row.offered_card_id);
        context.requireIncluded('office_cards', {
            office_id: row.office_id,
            card_id: row.wanted_card_id
        });
        if (context.cardOwner(row.wanted_card_id) !== context.accountId(row.recipient_id)) {
            throw new Error('wanted card is not owned by exchange recipient');
        }
        if (row.offered_card_id !== null &&
            context.cardOwner(row.offered_card_id) !== context.accountId(row.requester_id)) {
            throw new Error('offered card is not owned by exchange requester');
        }
        if (!['pending', 'accepted', 'declined', 'cancelled'].includes(row.status)) {
            throw new Error(`Unknown exchange status: ${row.status}`);
        }
        if (row.status !== 'pending' && descriptor.verifiedFinalStatus !== true) {
            throw new Error('final exchange status requires verifiedFinalStatus approval');
        }
        const updated = parseTimestamp(row.updated_at, 'exchange_requests updated_at').iso;
        return [targetOperation(table, sourceKey, 'fudaba_exchange_requests', ['id'], {
            id: row.id,
            office_id: row.office_id,
            requester_account_id: context.accountId(row.requester_id),
            recipient_account_id: context.accountId(row.recipient_id),
            wanted_card_id: row.wanted_card_id,
            offered_card_id: row.offered_card_id,
            note: row.note,
            status: row.status,
            version: 0,
            created_at: created.iso,
            updated_at: updated,
            resolved_at: row.status === 'pending' ? null : updated
        })];
    }
    case 'card_likes':
    case 'card_favorites':
        context.requireIncluded('cards', row.card_id);
        context.requireIncluded('users', row.user_id);
        return [targetOperation(table, sourceKey, `fudaba_${table}`, ['card_id', 'account_id'], {
            card_id: row.card_id,
            account_id: context.accountId(row.user_id),
            created_at: created.iso
        })];
    default:
        throw new Error(`No mapping for source table: ${table}`);
    }
}

function sourceTableConservation(reports, sourceCounts) {
    const output = {};
    for (const table of Object.keys(SOURCE_TABLES)) {
        const matching = reports.filter((report) => report.sourceTable === table);
        const count = (outcome) => matching
            .filter((report) => report.outcome === outcome)
            .reduce((total, report) => total + (report.count ?? 1), 0);
        const source = sourceCounts[table];
        const included = count('included');
        const excluded = count('excluded');
        const failed = count('failed');
        if (!Number.isSafeInteger(source) || source < 0 ||
            source !== included + excluded + failed) {
            throw new Error(
                `Source table conservation failed for ${table}: ` +
                `${source} != ${included} + ${excluded} + ${failed}`
            );
        }
        output[table] = { source, included, excluded, failed };
    }
    return output;
}

function summarizeSourceTables(sourceTables) {
    return Object.values(sourceTables).reduce(
        (summary, table) => ({
            included: summary.included + table.included,
            excluded: summary.excluded + table.excluded,
            failed: summary.failed + table.failed
        }),
        { included: 0, excluded: 0, failed: 0 }
    );
}

async function buildImportPlan(snapshotDirectory) {
    const snapshot = await loadSnapshot(snapshotDirectory);
    const descriptors = descriptorIndex(snapshot.rowsManifest);
    const mediaIndex = indexManifestEntries(
        manifestEntries(snapshot.mediaManifest, 'entries'),
        'media manifest'
    );
    const rightsIndex = indexManifestEntries(
        manifestEntries(snapshot.rightsManifest, 'approvals'),
        'rights manifest'
    );
    const reports = [];
    const reportsByIdentity = new Map();
    const includedRows = new Set();
    const accountMappings = new Map();
    const consumedMedia = new Set();
    const sourceCounts = Object.fromEntries(
        Object.entries(snapshot.rows).map(([table, rows]) => [
            table,
            NON_IMPORTED_TABLES.has(table)
                ? snapshot.rowsManifest.tables[table].count
                : rows.length
        ])
    );

    for (const [table, rows] of Object.entries(snapshot.rows)) {
        if (NON_IMPORTED_TABLES.has(table)) {
            const manifestTable = snapshot.rowsManifest.tables[table];
            if (rows.length !== 0 || manifestTable.migrated !== false ||
                manifestTable.redactedFromSnapshot !== true) {
                throw new Error(`Operational row count mismatch for ${table}`);
            }
            reports.push({
                sourceTable: table,
                count: manifestTable.count,
                outcome: 'excluded',
                reasonCode: 'source-table-not-migrated',
                reason: 'source-table-not-migrated'
            });
            continue;
        }
        for (const row of rows) {
            const identity = sourceRowIdentity(table, row);
            const descriptor = descriptors.get(identity);
            if (!descriptor || descriptor.rowSha256 !== canonicalHash(row)) {
                throw new Error(`Rows manifest does not match source row: ${identity}`);
            }
            const report = rowReport(table, descriptor);
            reports.push(report);
            reportsByIdentity.set(identity, report);
            if (INCLUDED_CLASSIFICATIONS.has(descriptor.classification)) includedRows.add(identity);
            if (table === 'users' && INCLUDED_CLASSIFICATIONS.has(descriptor.classification)) {
                if (descriptor.classification === 'owner-approved-reference') {
                    if (typeof descriptor.targetAccountId !== 'string' ||
                        descriptor.targetAccountId.length < 1 || descriptor.targetAccountId.length > 128) {
                        report.outcome = 'failed';
                        report.reasonCode =
                            'owner-approved-reference-requires-target-account';
                        report.reason = 'owner-approved-reference-requires-targetAccountId';
                        includedRows.delete(identity);
                    } else {
                        accountMappings.set(row.id, descriptor.targetAccountId);
                    }
                } else {
                    accountMappings.set(row.id, row.id);
                }
            }
        }
    }
    const importedSourceCount = reports.filter((report) => Object.hasOwn(report, 'sourceKey')).length;
    if (descriptors.size !== importedSourceCount) {
        throw new Error('Rows manifest contains entries not present in database.sqlite');
    }

    const loginAccounts = new Set();
    for (const table of ['oauth_accounts', 'email_credentials']) {
        for (const row of snapshot.rows[table]) {
            const descriptor = descriptors.get(sourceRowIdentity(table, row));
            if (descriptor && INCLUDED_CLASSIFICATIONS.has(descriptor.classification)) {
                loginAccounts.add(row.user_id);
            }
        }
    }
    for (const user of snapshot.rows.users) {
        const identity = sourceRowIdentity('users', user);
        const descriptor = descriptors.get(identity);
        const report = reportsByIdentity.get(identity);
        if (descriptor.classification === 'production-user-content' &&
            !loginAccounts.has(user.id)) {
            report.outcome = 'failed';
            report.reasonCode = 'account-without-login-method';
            report.reason = 'account-without-login-method';
            includedRows.delete(identity);
        }
    }

    const context = {
        mediaIndex,
        rightsIndex,
        consumedMedia,
        reportsByIdentity,
        exportedAt: parseTimestamp(
            snapshot.sourceJson.source.exportedAt,
            'source export time'
        ).iso,
        accountId(sourceAccountId) {
            const targetAccountId = accountMappings.get(sourceAccountId);
            if (!targetAccountId) {
                throw new Error(`Source account has no target mapping: ${sourceAccountId}`);
            }
            return targetAccountId;
        },
        isReferenceAccount(sourceAccountId) {
            const descriptor = descriptors.get(sourceRowIdentity('users', {
                id: sourceAccountId
            }));
            return descriptor?.classification === 'owner-approved-reference';
        },
        cardOwner(cardId) {
            const card = snapshot.rows.cards.find((candidate) => candidate.id === cardId);
            if (!card) throw new Error(`Source card is missing: ${cardId}`);
            return this.accountId(card.owner_id);
        },
        requireIncluded(table, key) {
            const definition = SOURCE_TABLES[table];
            const keyRow = definition.key.length === 1
                ? { [definition.key[0]]: key }
                : key;
            const identity = sourceRowIdentity(table, keyRow);
            if (!includedRows.has(identity)) throw new Error(`Required source row is excluded: ${identity}`);
        }
    };
    const operations = [];
    for (const table of IMPORT_TABLE_ORDER) {
        for (const row of snapshot.rows[table]) {
            const identity = sourceRowIdentity(table, row);
            const descriptor = descriptors.get(identity);
            const report = reportsByIdentity.get(identity);
            if (report.outcome === 'failed') continue;
            if (descriptor.classification === 'unknown') {
                report.outcome = 'failed';
                report.reasonCode = 'source-classification-unknown';
                report.reason = 'source-classification-unknown';
                continue;
            }
            if (descriptor.classification === 'demo-or-synthetic') {
                report.outcome = 'excluded';
                report.reasonCode = 'demo-or-synthetic';
                report.reason = 'demo-or-synthetic';
                continue;
            }
            try {
                const mapped = operationForRow(table, row, descriptor, context);
                mapped.forEach((operation) => {
                    validateTargetOperation(operation);
                    if (operation.stagedRow) {
                        validateTargetOperation({ ...operation, row: operation.stagedRow });
                    }
                });
                report.outcome = 'included';
                for (const operation of mapped) {
                    operation.sourceReport = report;
                    operation.sourceIdentity = identity;
                    report.targets.push({ table: operation.table, key: targetKey(operation) });
                    operations.push(operation);
                }
            } catch (error) {
                report.outcome = 'failed';
                report.reasonCode = 'source-row-invalid';
                report.reason = error.message;
                includedRows.delete(identity);
            }
        }
    }
    const unusedMedia = [...mediaIndex.keys()].filter((identity) => !consumedMedia.has(identity));
    const unusedRights = [...rightsIndex.keys()].filter((identity) => !consumedMedia.has(identity));
    if (unusedMedia.length || unusedRights.length) {
        throw new Error(
            `Media manifests contain unconsumed entries; media=${unusedMedia.join(',')}; ` +
            `rights=${unusedRights.join(',')}`
        );
    }

    const normalizedEmails = new Map();
    for (const operation of operations.filter((item) => item.table === 'platform_email_credentials')) {
        const email = operation.row.normalized_email;
        const existing = normalizedEmails.get(email);
        if (existing) {
            for (const candidate of [existing, operation]) {
                candidate.sourceReport.outcome = 'failed';
                candidate.sourceReport.reasonCode = 'normalized-email-collision';
                candidate.sourceReport.reason = `normalized-email-collision:${email}`;
            }
        } else {
            normalizedEmails.set(email, operation);
        }
    }
    function markUniqueConflicts(candidates, keyOf, code) {
        const seen = new Map();
        for (const operation of candidates.filter(
            (candidate) => candidate.sourceReport.outcome === 'included'
        )) {
            const key = keyOf(operation);
            const existing = seen.get(key);
            if (existing) {
                for (const candidate of [existing, operation]) {
                    candidate.sourceReport.outcome = 'failed';
                    candidate.sourceReport.reasonCode = code;
                    candidate.sourceReport.reason = `${code}:${key}`;
                }
            } else {
                seen.set(key, operation);
            }
        }
    }
    markUniqueConflicts(
        operations.filter((item) => item.table === 'platform_oauth_identities'),
        (item) => `${item.row.account_id}:${item.row.provider_code}`,
        'account-provider-collision'
    );
    markUniqueConflicts(
        operations.filter((item) => item.table === 'platform_email_credentials'),
        (item) => item.row.account_id,
        'account-email-collision'
    );
    markUniqueConflicts(
        operations.filter((item) => item.table === 'fudaba_exchange_requests' &&
            item.row.status === 'pending'),
        (item) => JSON.stringify([
            item.row.requester_account_id,
            item.row.recipient_account_id,
            item.row.wanted_card_id
        ]),
        'pending-exchange-collision'
    );
    markUniqueConflicts(
        operations.filter((item) => item.table === 'fudaba_cards'),
        (item) => item.row.front_object_key,
        'card-front-object-key-collision'
    );
    markUniqueConflicts(
        operations.filter((item) => item.table === 'fudaba_cards'),
        (item) => item.row.back_object_key,
        'card-back-object-key-collision'
    );
    const targetRows = new Map();
    for (const operation of operations) {
        if (operation.sourceReport.outcome !== 'included') continue;
        const identity = targetIdentity(operation);
        const existing = targetRows.get(identity);
        if (existing && canonicalHash(existing.row) !== canonicalHash(operation.row)) {
            operation.sourceReport.outcome = 'failed';
            operation.sourceReport.reasonCode = 'duplicate-target-conflict';
            operation.sourceReport.reason = `duplicate-target-conflict:${identity}`;
            existing.sourceReport.outcome = 'failed';
            existing.sourceReport.reasonCode = 'duplicate-target-conflict';
            existing.sourceReport.reason = `duplicate-target-conflict:${identity}`;
        } else if (!existing) {
            targetRows.set(identity, operation);
        }
    }
    const usableOperations = [...targetRows.values()].filter(
        (operation) => operation.sourceReport.outcome === 'included'
    );
    const mediaTargets = manifestEntries(snapshot.mediaManifest, 'entries')
        .filter((entry) =>
            entry.state === 'ready' && entry.disposition === 'store-protected'
        )
        .map((entry) => ({
            identity: mediaIdentity(entityKind(entry), entityId(entry), entitySlot(entry)),
            logicalObjectKey: mediaObjectKey(entry),
            state: 'ready',
            objectId: entry.objectId,
            physicalObjectKey: entry.physicalObjectKey,
            storageScope: 'private',
            byteSize: entry.bytes,
            contentType: entry.contentType,
            sha256: entry.sha256,
            etag: entry.targetEtag,
            targetBucket: entry.targetBucket
        }));
    const targetBuckets = new Set(mediaTargets.map((target) => target.targetBucket));
    if (targetBuckets.size > 1) {
        throw new Error('Fudaba media manifest spans more than one target bucket');
    }
    const sourceTables = sourceTableConservation(reports, sourceCounts);
    const summary = summarizeSourceTables(sourceTables);
    return {
        snapshot: {
            directory: snapshot.directory,
            sourceJson: snapshot.sourceJson,
            artifactSha256: snapshot.artifactSha256
        },
        mediaTargetBucket: mediaTargets[0]?.targetBucket || null,
        mediaTargets,
        operations: usableOperations,
        rows: reports,
        sourceCounts,
        sourceTables,
        summary,
        blockers: reports.filter((row) => row.outcome === 'failed')
    };
}

function databaseUrl(value) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error('DATABASE_URL is required');
    }
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw new Error('DATABASE_URL must be a PostgreSQL URL');
    }
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol) ||
        !parsed.hostname || parsed.pathname === '/') {
        throw new Error('DATABASE_URL must be a PostgreSQL URL');
    }
    return value;
}

function quotePgIdentifier(value) {
    return `"${value.replaceAll('"', '""')}"`;
}

function normalizedPgValue(table, column, value) {
    if (value instanceof Date) return value.toISOString();
    if (PG_BIGINT_COLUMNS.has(`${table}.${column}`) && value !== null) return String(value);
    return value;
}

function differingColumns(operation, actual) {
    return operation.compareColumns.filter((column) =>
        canonicalHash(normalizedPgValue(operation.table, column, actual[column])) !==
        canonicalHash(normalizedPgValue(operation.table, column, operation.row[column]))
    );
}

function projectedOperationRow(operation) {
    return Object.fromEntries(operation.compareColumns.map((column) => [
        column,
        normalizedPgValue(operation.table, column, operation.row[column])
    ]));
}

function projectedActualRow(operation, actual) {
    return Object.fromEntries(operation.compareColumns.map((column) => [
        column,
        normalizedPgValue(operation.table, column, actual[column])
    ]));
}

function alternativeUniqueKeys(operation) {
    switch (operation.table) {
    case 'platform_oauth_identities':
        return [['account_id', 'provider_code']];
    case 'platform_email_credentials':
        return [['account_id']];
    case 'fudaba_offices':
        return [['slug']];
    case 'fudaba_cards':
        return [['front_object_key'], ['back_object_key']];
    case 'fudaba_exchange_requests':
        return operation.row.status === 'pending'
            ? [['requester_account_id', 'recipient_account_id', 'wanted_card_id']]
            : [];
    default:
        return [];
    }
}

function targetTableSummary(operations, targets) {
    const summary = {};
    for (const operation of operations) {
        summary[operation.table] ||= { expected: 0, states: {} };
        summary[operation.table].expected += 1;
    }
    for (const target of targets) {
        summary[target.table] ||= { expected: 0, states: {} };
        summary[target.table].states[target.state] =
            (summary[target.table].states[target.state] || 0) + 1;
    }
    return summary;
}

function projectedMediaTarget(target) {
    return {
        state: target.state,
        objectId: target.objectId,
        physicalObjectKey: target.physicalObjectKey,
        storageScope: target.storageScope,
        byteSize: Number(target.byteSize),
        contentType: target.contentType,
        sha256: target.sha256,
        etag: target.etag
    };
}

async function inspectMediaControlPlane(client, expected, lock = false) {
    const result = await client.query(
        `SELECT i.state, v.object_id, v.physical_key, v.storage_scope,
                v.byte_size, v.content_type, v.sha256, v.etag
         FROM public.s3_object_index AS i
         JOIN public.s3_object_versions AS v ON v.object_id=i.object_id
         WHERE i.logical_key=$1${lock ? ' FOR SHARE OF i, v' : ''}`,
        [expected.logicalObjectKey]
    );
    const expectedProjection = projectedMediaTarget(expected);
    const expectedTargetSha256 = canonicalHash(expectedProjection);
    if (!result.rows.length) {
        return {
            state: 'missing',
            differentColumns: ['logicalObjectKey'],
            expectedTargetSha256,
            actualTargetSha256: null
        };
    }
    const row = result.rows[0];
    const actualProjection = projectedMediaTarget({
        state: row.state,
        objectId: row.object_id,
        physicalObjectKey: row.physical_key,
        storageScope: row.storage_scope,
        byteSize: row.byte_size,
        contentType: row.content_type,
        sha256: row.sha256,
        etag: row.etag
    });
    const differentColumns = Object.keys(expectedProjection).filter((column) =>
        canonicalHash(actualProjection[column]) !== canonicalHash(expectedProjection[column])
    );
    return {
        state: differentColumns.length ? 'different' : 'ready',
        differentColumns,
        expectedTargetSha256,
        actualTargetSha256: canonicalHash(actualProjection)
    };
}

function assertMediaTargetBucket(plan, options) {
    if (!plan.mediaTargets.length) return;
    if (options.targetBucket !== plan.mediaTargetBucket) {
        throw new MigrationBlockedError('Import requires exact --target-bucket', {
            snapshotId: plan.snapshot.sourceJson.snapshotId,
            sourceSha256: plan.snapshot.sourceJson.sourceExport.sha256,
            expectedTargetBucket: plan.mediaTargetBucket
        });
    }
}

async function inspectOperation(client, operation) {
    const where = operation.keyColumns.map(
        (column, index) => `${quotePgIdentifier(column)} = $${index + 1}`
    ).join(' AND ');
    const result = await client.query(
        `SELECT ${operation.compareColumns.map(quotePgIdentifier).join(', ')} ` +
        `FROM public.${quotePgIdentifier(operation.table)} WHERE ${where}`,
        operation.keyColumns.map((column) => operation.row[column])
    );
    const expectedTargetSha256 = canonicalHash(projectedOperationRow(operation));
    if (!result.rows.length) {
        for (const columns of alternativeUniqueKeys(operation)) {
            const uniqueWhere = columns.map(
                (column, index) => `${quotePgIdentifier(column)} = $${index + 1}`
            ).join(' AND ');
            const partialPredicate = operation.table === 'fudaba_exchange_requests'
                ? " AND status = 'pending'"
                : '';
            const uniqueResult = await client.query(
                `SELECT 1 FROM public.${quotePgIdentifier(operation.table)} ` +
                `WHERE ${uniqueWhere}${partialPredicate} LIMIT 1`,
                columns.map((column) => operation.row[column])
            );
            if (uniqueResult.rows.length) {
                return {
                    state: 'conflict',
                    differentColumns: columns.map((column) => `unique:${column}`),
                    expectedTargetSha256
                };
            }
        }
        return { state: 'missing', differentColumns: [], expectedTargetSha256 };
    }
    const differentColumns = differingColumns(operation, result.rows[0]);
    const actualTargetSha256 = canonicalHash(projectedActualRow(operation, result.rows[0]));
    return differentColumns.length
        ? { state: 'conflict', differentColumns, expectedTargetSha256, actualTargetSha256 }
        : {
            state: 'unchanged',
            differentColumns: [],
            expectedTargetSha256,
            actualTargetSha256
        };
}

function operationWithRow(operation, row) {
    return { ...operation, row };
}

async function insertOperation(client, operation, row = operation.row) {
    const columns = Object.keys(row);
    const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
    await client.query(
        `INSERT INTO public.${quotePgIdentifier(operation.table)} ` +
        `(${columns.map(quotePgIdentifier).join(', ')}) VALUES (${placeholders})`,
        columns.map((column) => row[column])
    );
}

async function transitionOperation(client, operation, fromRow, toRow) {
    const changedColumns = operation.compareColumns.filter((column) =>
        canonicalHash(normalizedPgValue(operation.table, column, fromRow[column])) !==
        canonicalHash(normalizedPgValue(operation.table, column, toRow[column]))
    );
    if (!changedColumns.length) return;
    const assignments = changedColumns.map(
        (column, index) => `${quotePgIdentifier(column)} = $${index + 1}`
    );
    const keyOffset = changedColumns.length;
    const keyPredicates = operation.keyColumns.map(
        (column, index) =>
            `${quotePgIdentifier(column)} = $${keyOffset + index + 1}`
    );
    const compareOffset = keyOffset + operation.keyColumns.length;
    const comparePredicates = operation.compareColumns.map(
        (column, index) =>
            `${quotePgIdentifier(column)} IS NOT DISTINCT FROM ` +
            `$${compareOffset + index + 1}`
    );
    const values = [
        ...changedColumns.map((column) => toRow[column]),
        ...operation.keyColumns.map((column) => fromRow[column]),
        ...operation.compareColumns.map((column) => fromRow[column])
    ];
    const result = await client.query(
        `UPDATE public.${quotePgIdentifier(operation.table)} ` +
        `SET ${assignments.join(', ')} ` +
        `WHERE ${[...keyPredicates, ...comparePredicates].join(' AND ')}`,
        values
    );
    if (result.rowCount !== 1) {
        throw new Error(`Target changed while staging import: ${operation.table}`);
    }
}

function poolFor(connectionString, applicationName) {
    return new Pool({
        connectionString: databaseUrl(connectionString),
        max: 1,
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 10_000,
        statement_timeout: 120_000,
        idle_in_transaction_session_timeout: 120_000,
        application_name: applicationName,
        allowExitOnIdle: true
    });
}

class MigrationBlockedError extends Error {
    constructor(message, report) {
        super(message);
        this.name = 'MigrationBlockedError';
        this.report = report;
    }
}

async function compareOrImport(plan, options = {}) {
    const apply = options.apply === true;
    const report = {
        schemaVersion: 1,
        snapshotId: plan.snapshot.sourceJson.snapshotId,
        sourceSha256: plan.snapshot.sourceJson.sourceExport.sha256,
        artifactSha256: plan.snapshot.artifactSha256,
        mode: apply ? 'apply' : 'dry-run',
        committed: false,
        rolledBack: false,
        commitAttempted: false,
        commitOutcome: apply ? 'not-attempted' : 'not-applicable',
        outcomeUnknown: false,
        summary: {
            ...plan.summary,
            mediaReady: 0,
            mediaConflicts: 0,
            missing: 0,
            unchanged: 0,
            inserted: 0,
            conflicts: 0
        },
        rows: plan.rows,
        sourceTables: plan.sourceTables,
        targetTables: targetTableSummary(plan.operations, []),
        mediaTargets: [],
        targets: []
    };
    if (plan.blockers.length) {
        throw new MigrationBlockedError(
            `Fudaba import blocked by ${plan.blockers.length} source row failure(s)`,
            report
        );
    }
    const pool = poolFor(options.connectionString, 'imsweb-fudaba-metadata-import');
    let client;
    let advisoryLocked = false;
    let transactionOpen = false;
    const stagedOperations = [];
    const markRolledBack = () => {
        const rolledBackInserts = report.targets.filter((target) => target.state === 'inserted');
        for (const target of rolledBackInserts) target.state = 'rolled-back';
        report.summary.rolledBackInserts = rolledBackInserts.length;
        report.summary.inserted = 0;
        report.rolledBack = apply;
    };
    const refreshRowSummary = () => {
        report.sourceTables = sourceTableConservation(report.rows, plan.sourceCounts);
        Object.assign(report.summary, summarizeSourceTables(report.sourceTables));
        report.targetTables = targetTableSummary(plan.operations, report.targets);
    };
    try {
        client = await pool.connect();
        await client.query("SELECT pg_advisory_lock(hashtext('imsweb-fudaba-metadata-import'))");
        advisoryLocked = true;
        await client.query(apply
            ? 'BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE'
            : 'BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE READ ONLY');
        transactionOpen = true;
        for (const expected of plan.mediaTargets) {
            const inspection = await inspectMediaControlPlane(client, expected, apply);
            report.mediaTargets.push({
                identity: expected.identity,
                logicalObjectKey: expected.logicalObjectKey,
                state: inspection.state,
                differentColumns: inspection.differentColumns,
                expectedTargetSha256: inspection.expectedTargetSha256,
                actualTargetSha256: inspection.actualTargetSha256
            });
            if (inspection.state === 'ready') report.summary.mediaReady += 1;
            else report.summary.mediaConflicts += 1;
        }
        if (report.summary.mediaConflicts) {
            throw new MigrationBlockedError(
                `Fudaba import found ${report.summary.mediaConflicts} media target conflict(s)`,
                report
            );
        }
        for (const operation of plan.operations) {
            const inspection = await inspectOperation(client, operation);
            const target = {
                table: operation.table,
                key: targetKey(operation),
                state: inspection.state,
                expectedTargetSha256: inspection.expectedTargetSha256,
                actualTargetSha256: inspection.actualTargetSha256 || null
            };
            if (inspection.state === 'conflict') {
                target.differentColumns = inspection.differentColumns;
                operation.sourceReport.outcome = 'failed';
                operation.sourceReport.reasonCode = 'target-conflict';
                operation.sourceReport.reason = `target-conflict:${operation.table}`;
                report.summary.conflicts += 1;
            } else if (inspection.state === 'missing') {
                if (operation.requiredExisting) {
                    target.state = 'conflict';
                    target.differentColumns = ['id'];
                    operation.sourceReport.outcome = 'failed';
                    operation.sourceReport.reasonCode = 'required-existing-target-missing';
                    operation.sourceReport.reason =
                        `required-existing-target-missing:${operation.table}`;
                    report.summary.conflicts += 1;
                    report.targets.push(target);
                    continue;
                }
                report.summary.missing += 1;
                if (apply) {
                    try {
                        const writtenOperation = operation.stagedRow
                            ? operationWithRow(operation, operation.stagedRow)
                            : operation;
                        await insertOperation(client, writtenOperation);
                        const verification = await inspectOperation(client, writtenOperation);
                        if (verification.state !== 'unchanged') {
                            throw new Error(
                                `Inserted target did not read back exactly: ${operation.table}`
                            );
                        }
                        if (operation.stagedRow) {
                            stagedOperations.push({ operation, target });
                        } else {
                            target.actualTargetSha256 = verification.actualTargetSha256;
                        }
                    } catch (error) {
                        operation.sourceReport.outcome = 'failed';
                        operation.sourceReport.reasonCode = 'target-write-failed';
                        operation.sourceReport.reason = `target-write-failed:${operation.table}`;
                        throw error;
                    }
                    target.state = 'inserted';
                    report.summary.inserted += 1;
                }
            } else {
                report.summary.unchanged += 1;
                if (apply && operation.stagedRow) {
                    try {
                        await transitionOperation(
                            client,
                            operation,
                            operation.row,
                            operation.stagedRow
                        );
                        const stagedInspection = await inspectOperation(
                            client,
                            operationWithRow(operation, operation.stagedRow)
                        );
                        if (stagedInspection.state !== 'unchanged') {
                            throw new Error(
                                `Staged target did not read back exactly: ${operation.table}`
                            );
                        }
                        stagedOperations.push({ operation, target });
                    } catch (error) {
                        operation.sourceReport.outcome = 'failed';
                        operation.sourceReport.reasonCode = 'target-write-failed';
                        operation.sourceReport.reason = `target-write-failed:${operation.table}`;
                        throw error;
                    }
                }
            }
            report.targets.push(target);
        }
        if (report.summary.conflicts) {
            refreshRowSummary();
            await client.query('ROLLBACK');
            transactionOpen = false;
            markRolledBack();
            throw new MigrationBlockedError(
                `Fudaba import found ${report.summary.conflicts} target conflict(s)`,
                report
            );
        }
        if (apply) {
            for (const { operation, target } of stagedOperations) {
                try {
                    await transitionOperation(
                        client,
                        operation,
                        operation.stagedRow,
                        operation.row
                    );
                    const verification = await inspectOperation(client, operation);
                    if (verification.state !== 'unchanged') {
                        throw new Error(
                            `Final target did not read back exactly: ${operation.table}`
                        );
                    }
                    target.actualTargetSha256 = verification.actualTargetSha256;
                } catch (error) {
                    operation.sourceReport.outcome = 'failed';
                    operation.sourceReport.reasonCode = 'target-write-failed';
                    operation.sourceReport.reason = `target-write-failed:${operation.table}`;
                    throw error;
                }
            }
            report.commitAttempted = true;
            report.commitOutcome = 'attempted';
            await client.query('COMMIT');
            transactionOpen = false;
            if (typeof options.afterCommitSent === 'function') {
                await options.afterCommitSent();
            }
            report.committed = true;
            report.commitOutcome = 'acknowledged';
        } else {
            await client.query('ROLLBACK');
            transactionOpen = false;
        }
        refreshRowSummary();
        return report;
    } catch (error) {
        if (report.commitAttempted && !report.committed) {
            report.outcomeUnknown = true;
            report.commitOutcome = 'unknown';
            report.rolledBack = false;
        } else if (client && transactionOpen && !report.rolledBack) {
            try {
                await client.query('ROLLBACK');
                transactionOpen = false;
                markRolledBack();
            } catch {
                report.outcomeUnknown = apply;
                report.rollbackOutcome = 'unknown';
            }
        }
        refreshRowSummary();
        if (error instanceof MigrationBlockedError) throw error;
        throw new MigrationBlockedError(`Fudaba import failed: ${error.message}`, report);
    } finally {
        if (client && advisoryLocked) {
            await client.query(
                "SELECT pg_advisory_unlock(hashtext('imsweb-fudaba-metadata-import'))"
            ).catch(() => undefined);
        }
        client?.release();
        await pool.end();
    }
}

async function importSnapshot(options) {
    const plan = await buildImportPlan(options.snapshotDirectory);
    assertMediaTargetBucket(plan, options);
    if (options.apply) {
        if (options.confirmSnapshotId !== plan.snapshot.sourceJson.snapshotId) {
            throw new MigrationBlockedError('Apply requires exact --confirm-snapshot-id', {
                snapshotId: plan.snapshot.sourceJson.snapshotId,
                sourceSha256: plan.snapshot.sourceJson.sourceExport.sha256
            });
        }
        if (options.confirmSourceSha256 !== plan.snapshot.sourceJson.sourceExport.sha256) {
            throw new MigrationBlockedError('Apply requires exact --confirm-source-sha256', {
                snapshotId: plan.snapshot.sourceJson.snapshotId,
                sourceSha256: plan.snapshot.sourceJson.sourceExport.sha256
            });
        }
        for (const [name, value, option] of [
            ['source', options.confirmSourceManifestSha256,
                '--confirm-source-manifest-sha256'],
            ['rows', options.confirmRowsSha256, '--confirm-rows-sha256'],
            ['mediaPlan', options.confirmMediaPlanSha256, '--confirm-plan-sha256'],
            ['media', options.confirmMediaSha256, '--confirm-media-sha256'],
            ['rights', options.confirmRightsSha256, '--confirm-rights-sha256']
        ]) {
            const expected = plan.snapshot.artifactSha256[name];
            if (expected === null) continue;
            if (value !== expected) {
                throw new MigrationBlockedError(`Apply requires exact ${option}`, {
                    snapshotId: plan.snapshot.sourceJson.snapshotId,
                    sourceSha256: plan.snapshot.sourceJson.sourceExport.sha256,
                    artifactSha256: plan.snapshot.artifactSha256
                });
            }
        }
        if (plan.mediaTargets.length &&
            options.confirmTargetBucket !== plan.mediaTargetBucket) {
            throw new MigrationBlockedError(
                'Apply requires exact --confirm-target-bucket',
                {
                    snapshotId: plan.snapshot.sourceJson.snapshotId,
                    sourceSha256: plan.snapshot.sourceJson.sourceExport.sha256,
                    expectedTargetBucket: plan.mediaTargetBucket
                }
            );
        }
    }
    try {
        return await compareOrImport(plan, options);
    } catch (error) {
        if (!(error instanceof MigrationBlockedError) ||
            options.apply !== true || error.report?.outcomeUnknown !== true) {
            throw error;
        }
        try {
            const reconciliation = await reconcileSnapshot({
                snapshotDirectory: options.snapshotDirectory,
                connectionString: options.connectionString,
                targetBucket: options.targetBucket,
                write: false
            });
            error.report.reconciliation = reconciliation;
            if (reconciliation.status === 'passed') {
                error.report.committed = true;
                error.report.commitOutcome = 'reconciled';
                error.report.outcomeUnknown = false;
                return error.report;
            }
        } catch (reconciliationError) {
            error.report.reconciliationError = reconciliationError.message;
        }
        throw error;
    }
}

async function reconcileSnapshot(options) {
    const plan = await buildImportPlan(options.snapshotDirectory);
    assertMediaTargetBucket(plan, options);
    const report = {
        schemaVersion: 1,
        snapshotId: plan.snapshot.sourceJson.snapshotId,
        sourceSha256: plan.snapshot.sourceJson.sourceExport.sha256,
        artifactSha256: plan.snapshot.artifactSha256,
        status: 'failed',
        summary: {
            ...plan.summary,
            expectedTargets: plan.operations.length,
            unchanged: 0,
            missing: 0,
            different: 0,
            mediaReady: 0,
            mediaMissing: 0,
            mediaDifferent: 0
        },
        rows: plan.rows,
        sourceTables: plan.sourceTables,
        targetTables: targetTableSummary(plan.operations, []),
        mediaTargets: [],
        targets: []
    };
    if (!plan.blockers.length) {
        const pool = poolFor(options.connectionString, 'imsweb-fudaba-metadata-reconcile');
        let client;
        let advisoryLocked = false;
        let transactionOpen = false;
        try {
            client = await pool.connect();
            await client.query("SELECT pg_advisory_lock(hashtext('imsweb-fudaba-metadata-import'))");
            advisoryLocked = true;
            await client.query('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE READ ONLY');
            transactionOpen = true;
            for (const expected of plan.mediaTargets) {
                const inspection = await inspectMediaControlPlane(client, expected);
                report.summary[`media${inspection.state[0].toUpperCase()}${inspection.state.slice(1)}`]
                    += 1;
                report.mediaTargets.push({
                    identity: expected.identity,
                    logicalObjectKey: expected.logicalObjectKey,
                    ...inspection
                });
            }
            for (const operation of plan.operations) {
                const inspection = await inspectOperation(client, operation);
                const state = inspection.state === 'conflict' ? 'different' : inspection.state;
                report.summary[state] += 1;
                const target = {
                    table: operation.table,
                    key: targetKey(operation),
                    state,
                    expectedTargetSha256: inspection.expectedTargetSha256,
                    actualTargetSha256: inspection.actualTargetSha256 || null
                };
                if (state === 'different') target.differentColumns = inspection.differentColumns;
                report.targets.push(target);
            }
            await client.query('ROLLBACK');
            transactionOpen = false;
        } finally {
            if (client && transactionOpen) {
                await client.query('ROLLBACK').catch(() => undefined);
            }
            if (client && advisoryLocked) {
                await client.query(
                    "SELECT pg_advisory_unlock(hashtext('imsweb-fudaba-metadata-import'))"
                ).catch(() => undefined);
            }
            client?.release();
            await pool.end();
        }
    }
    report.status = plan.blockers.length || report.summary.missing || report.summary.different ||
        report.summary.mediaMissing || report.summary.mediaDifferent
        ? 'failed'
        : 'passed';
    report.targetTables = targetTableSummary(plan.operations, report.targets);
    if (options.write !== false) {
        writeJsonAtomic(path.join(plan.snapshot.directory, 'reconciliation.json'), report);
    }
    return report;
}

function optionValue(argv, index, option) {
    if (!argv[index + 1] || argv[index + 1].startsWith('--')) {
        throw new Error(`${option} requires a value`);
    }
    return argv[index + 1];
}

function parseCliOptions(argv) {
    const options = {};
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--') continue;
        if (argument === '--apply') {
            options.apply = true;
            continue;
        }
        if (argument === '--dry-run') {
            options.apply = false;
            continue;
        }
        if (argument === '--no-write') {
            options.write = false;
            continue;
        }
        if (argument === '--help' || argument === '-h') {
            options.help = true;
            continue;
        }
        const names = {
            '--source': 'source',
            '--source-sqlite': 'source',
            '--source-database': 'source',
            '--snapshot-id': 'snapshotId',
            '--snapshot-root': 'snapshotRoot',
            '--snapshot': 'snapshotDirectory',
            '--snapshot-directory': 'snapshotDirectory',
            '--snapshot-dir': 'snapshotDirectory',
            '--d1-database-id': 'd1DatabaseId',
            '--r2-bucket': 'r2Bucket',
            '--app-version': 'appVersion',
            '--export-time': 'exportTime',
            '--fudaba-commit': 'fudabaCommit',
            '--classifications': 'classifications',
            '--database-url': 'connectionString',
            '--confirm-snapshot-id': 'confirmSnapshotId',
            '--confirm-source-sha256': 'confirmSourceSha256',
            '--confirm-source-manifest-sha256': 'confirmSourceManifestSha256',
            '--confirm-rows-sha256': 'confirmRowsSha256',
            '--confirm-plan-sha256': 'confirmMediaPlanSha256',
            '--confirm-media-sha256': 'confirmMediaSha256',
            '--confirm-rights-sha256': 'confirmRightsSha256',
            '--target-bucket': 'targetBucket',
            '--confirm-target-bucket': 'confirmTargetBucket'
        };
        const name = names[argument];
        if (!name) throw new Error(`Unknown option: ${argument}`);
        options[name] = optionValue(argv, index, argument);
        index += 1;
    }
    return options;
}

function resolveSnapshotDirectory(options) {
    if (options.snapshotDirectory) return path.resolve(options.snapshotDirectory);
    if (!options.snapshotId) throw new Error('--snapshot or --snapshot-id is required');
    validateSnapshotId(options.snapshotId);
    return path.join(path.resolve(options.snapshotRoot || DEFAULT_SNAPSHOT_ROOT), options.snapshotId);
}

function extractHelp() {
    return 'Usage: fudaba-extract.js --source SQLITE --snapshot-id ID ' +
        '--d1-database-id ID --r2-bucket BUCKET --app-version VERSION --export-time ISO ' +
        `--fudaba-commit ${FUDABA_COMMIT} ` +
        '[--snapshot-root DIRECTORY] [--classifications JSON]';
}

function importHelp() {
    return 'Usage: fudaba-import.js (--snapshot DIRECTORY | --snapshot-id ID) ' +
        '[--database-url URL] --target-bucket BUCKET ' +
        '[--apply --confirm-snapshot-id ID ' +
        '--confirm-source-sha256 SHA256 --confirm-source-manifest-sha256 SHA256 ' +
        '--confirm-rows-sha256 SHA256 --confirm-plan-sha256 SHA256 ' +
        '--confirm-media-sha256 SHA256 --confirm-rights-sha256 SHA256 ' +
        '--confirm-target-bucket BUCKET]';
}

function reconcileHelp() {
    return 'Usage: fudaba-reconcile.js (--snapshot DIRECTORY | --snapshot-id ID) ' +
        '[--database-url URL] --target-bucket BUCKET [--no-write]';
}

async function runMain(action, help, argv, environment) {
    try {
        const options = parseCliOptions(argv);
        if (options.help) {
            process.stdout.write(`${help()}\n`);
            return null;
        }
        if (action === extractSnapshot) {
            if (!options.source || !options.snapshotId) throw new Error(extractHelp());
        } else {
            options.snapshotDirectory = resolveSnapshotDirectory(options);
            options.connectionString = options.connectionString || environment.DATABASE_URL;
            const configuredBucket = environment.IMS_S3_BUCKET?.trim();
            if (configuredBucket && options.targetBucket &&
                configuredBucket !== options.targetBucket) {
                throw new Error('--target-bucket differs from IMS_S3_BUCKET');
            }
            options.targetBucket = configuredBucket || options.targetBucket;
        }
        const report = await action(options);
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        if (action === reconcileSnapshot && report.status !== 'passed') process.exitCode = 1;
        return report;
    } catch (error) {
        if (error.report) process.stderr.write(`${JSON.stringify(error.report, null, 2)}\n`);
        console.error(error.message);
        process.exitCode = 1;
        return null;
    }
}

function extractMain(argv = process.argv.slice(2), environment = process.env) {
    return runMain(extractSnapshot, extractHelp, argv, environment);
}

function importMain(argv = process.argv.slice(2), environment = process.env) {
    return runMain(importSnapshot, importHelp, argv, environment);
}

function reconcileMain(argv = process.argv.slice(2), environment = process.env) {
    return runMain(reconcileSnapshot, reconcileHelp, argv, environment);
}

module.exports = {
    DEFAULT_SNAPSHOT_ROOT,
    FUDABA_COMMIT,
    FUDABA_D1_DATABASE_ID,
    FUDABA_MIGRATIONS,
    FUDABA_R2_BUCKET,
    FUDABA_REPOSITORY,
    INCLUDED_CLASSIFICATIONS,
    IMPORT_TABLE_ORDER,
    MigrationBlockedError,
    SERIES_MAPPINGS,
    SOURCE_CLASSIFICATIONS,
    SOURCE_TABLES,
    assertLogicalMediaKey,
    buildImportPlan,
    buildRowsManifest,
    canonicalHash,
    canonicalize,
    compareOrImport,
    databaseUrl,
    descriptorIndex,
    extractMain,
    extractSnapshot,
    importMain,
    importSnapshot,
    loadSnapshot,
    mapSeries,
    mapSourceRow: operationForRow,
    normalizeEmail,
    parseArguments: parseCliOptions,
    parseCliOptions,
    parseTimestamp,
    reconcileMain,
    reconcileSnapshot,
    resolveMedia,
    resolveOptionalMedia,
    sha256,
    sha256File,
    sourceManifestKey,
    sourceRowIdentity,
    validateSourceDatabase,
    validateTargetOperation,
    validateSnapshotId
};
