'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();
const {
    FUDABA_COMMIT,
    FUDABA_MIGRATIONS,
    SERIES_MAPPINGS,
    buildImportPlan,
    canonicalHash,
    extractSnapshot,
    importSnapshot,
    mapSeries,
    parseTimestamp,
    reconcileSnapshot,
    sha256,
    sha256File
} = require('../../scripts/migration/fudaba-metadata');
const {
    createPostgresTestHarness,
    postgresIntegrationEnabled
} = require('../integration/postgres-harness.ts');

const SOURCE_SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE "d1_migrations"(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
INSERT INTO d1_migrations (name) VALUES
    ('0001_initial.sql'),
    ('0002_official_demo_card_art.sql'),
    ('0003_public_card_users.sql'),
    ('0004_interactive_card_wall.sql'),
    ('0005_oauth_profiles.sql'),
    ('0006_office_series_tags.sql'),
    ('0007_office_management.sql'),
    ('0008_series_office_covers.sql'),
    ('0009_card_interactions.sql'),
    ('0010_email_credentials.sql');

CREATE TABLE users (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    avatar_url TEXT NOT NULL,
    home_city TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    bio TEXT NOT NULL DEFAULT '',
    updated_at TEXT
);
CREATE TABLE oauth_accounts (
    provider TEXT NOT NULL CHECK(provider IN ('google', 'github')),
    provider_user_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider_username TEXT NOT NULL,
    provider_avatar_url TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (provider, provider_user_id)
);
CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE oauth_states (
    state_hash TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK(provider IN ('google', 'github')),
    code_verifier TEXT,
    linking_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE email_credentials (
    email TEXT PRIMARY KEY COLLATE NOCASE,
    user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE offices (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    owner_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    intro TEXT NOT NULL,
    city TEXT NOT NULL,
    address TEXT NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    accent TEXT NOT NULL DEFAULT '#ef5b6c',
    cover_image TEXT NOT NULL,
    is_open INTEGER NOT NULL DEFAULT 1,
    visitor_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    archived_at TEXT,
    updated_at TEXT
);
CREATE TABLE series_tags (
    name TEXT PRIMARY KEY CHECK(length(name) BETWEEN 1 AND 40)
);
CREATE TABLE office_series_tags (
    office_id TEXT NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
    series_tag TEXT NOT NULL REFERENCES series_tags(name) ON UPDATE CASCADE ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (office_id, series_tag)
);
CREATE TABLE cards (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id),
    producer_name TEXT NOT NULL,
    display_name TEXT NOT NULL,
    series TEXT NOT NULL,
    favorite_idol TEXT NOT NULL,
    front_image TEXT NOT NULL,
    back_image TEXT NOT NULL,
    accent TEXT NOT NULL DEFAULT '#4f64dd',
    bio TEXT NOT NULL,
    trade_note TEXT NOT NULL,
    available INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    source_url TEXT,
    source_label TEXT,
    source_credit TEXT
);
CREATE TABLE office_cards (
    office_id TEXT NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    pinned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    position_x REAL NOT NULL DEFAULT 50,
    position_y REAL NOT NULL DEFAULT 50,
    rotation REAL NOT NULL DEFAULT 0,
    z_index INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (office_id, card_id)
);
CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    office_id TEXT NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
    author_id TEXT NOT NULL REFERENCES users(id),
    content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 280),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE exchange_requests (
    id TEXT PRIMARY KEY,
    office_id TEXT NOT NULL REFERENCES offices(id),
    requester_id TEXT NOT NULL REFERENCES users(id),
    recipient_id TEXT NOT NULL REFERENCES users(id),
    wanted_card_id TEXT NOT NULL REFERENCES cards(id),
    offered_card_id TEXT REFERENCES cards(id),
    note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'accepted', 'declined', 'cancelled')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE card_likes (
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (card_id, user_id)
);
CREATE TABLE card_favorites (
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (card_id, user_id)
);

CREATE INDEX offices_coordinates_idx ON offices(latitude, longitude);
CREATE INDEX offices_city_idx ON offices(city);
CREATE INDEX offices_public_idx ON offices(archived_at, visitor_count DESC);
CREATE INDEX office_cards_office_idx ON office_cards(office_id, pinned_at DESC);
CREATE INDEX office_cards_wall_order_idx ON office_cards(office_id, z_index DESC);
CREATE INDEX messages_office_idx ON messages(office_id, created_at DESC);
CREATE INDEX exchange_recipient_idx
    ON exchange_requests(recipient_id, status, created_at DESC);
CREATE INDEX exchange_requester_idx
    ON exchange_requests(requester_id, status, created_at DESC);
CREATE INDEX oauth_accounts_user_idx ON oauth_accounts(user_id);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);
CREATE INDEX oauth_states_expiry_idx ON oauth_states(expires_at);
CREATE INDEX office_series_tags_series_idx
    ON office_series_tags(series_tag, office_id);
CREATE INDEX card_likes_user_idx ON card_likes(user_id, created_at DESC);
CREATE INDEX card_favorites_user_idx ON card_favorites(user_id, created_at DESC);
CREATE INDEX email_credentials_user_idx ON email_credentials(user_id);

CREATE TRIGGER office_cards_require_active_insert
BEFORE INSERT ON office_cards
WHEN (SELECT archived_at FROM offices WHERE id = NEW.office_id) IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'OFFICE_ARCHIVED');
END;
CREATE TRIGGER office_cards_require_active_update
BEFORE UPDATE ON office_cards
WHEN (SELECT archived_at FROM offices WHERE id = NEW.office_id) IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'OFFICE_ARCHIVED');
END;
CREATE TRIGGER messages_require_active_insert
BEFORE INSERT ON messages
WHEN (SELECT archived_at FROM offices WHERE id = NEW.office_id) IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'OFFICE_ARCHIVED');
END;
CREATE TRIGGER exchanges_require_active_insert
BEFORE INSERT ON exchange_requests
WHEN (SELECT archived_at FROM offices WHERE id = NEW.office_id) IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'OFFICE_ARCHIVED');
END;
`;

const SESSION_CANARY = 'DO_NOT_IMPORT_SESSION_TOKEN_HASH';
const STATE_CANARY = 'DO_NOT_IMPORT_OAUTH_STATE_HASH';
const VERIFIER_CANARY = 'DO_NOT_LEAK_CODE_VERIFIER';
const PASSWORD_CANARY = 'a'.repeat(64);
const SALT_CANARY = 'DO_NOT_LEAK_PASSWORD_SALT';
const SERIES = [...SERIES_MAPPINGS.keys()];
const TARGET_BUCKET = 'imsweb-media-test';

function open(filename) {
    return new sqlite3.Database(filename);
}

function exec(database, sql) {
    return new Promise((resolve, reject) => {
        database.exec(sql, (error) => error ? reject(error) : resolve());
    });
}

function run(database, sql, values = []) {
    return new Promise((resolve, reject) => {
        database.run(sql, values, (error) => error ? reject(error) : resolve());
    });
}

function close(database) {
    return new Promise((resolve, reject) => {
        database.close((error) => error ? reject(error) : resolve());
    });
}

function readJson(filename) {
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

function writeJson(filename, value) {
    fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function mediaEntry(kind, id, slot, sourceReference) {
    const extension = 'png';
    const bases = {
        account: `community/fudaba/accounts/${id}/${slot}.${extension}`,
        office: `community/fudaba/offices/${id}/${slot}.${extension}`,
        card: `community/fudaba/cards/${id}/${slot}.${extension}`
    };
    const digest = sha256(`${kind}:${id}:${slot}`);
    const bindingSha256 = sha256(`binding:${kind}:${id}:${slot}`);
    return {
        entityKind: kind,
        entityId: id,
        slot,
        sourceReference,
        logicalObjectKey: bases[kind],
        state: 'ready',
        disposition: 'store-protected',
        storageScope: 'private',
        targetBucket: 'imsweb-media-test',
        objectId: `object-${kind}-${id}-${slot}`,
        physicalObjectKey: `test/__protected/${bases[kind]}`,
        targetEtag: `etag-${kind}-${id}-${slot}`,
        bytes: 128,
        contentType: 'image/png',
        bindingSha256,
        sha256: digest,
        readbackSha256: digest
    };
}

function snapshotConfirmations(directory) {
    const source = readJson(path.join(directory, 'source.json'));
    return {
        confirmSnapshotId: source.snapshotId,
        confirmSourceSha256: source.sourceExport.sha256,
        confirmSourceManifestSha256: sha256File(path.join(directory, 'source.json')),
        confirmRowsSha256: sha256File(path.join(directory, 'rows-manifest.json')),
        confirmMediaPlanSha256: sha256File(path.join(directory, 'media-plan.json')),
        confirmMediaSha256: sha256File(path.join(directory, 'media-manifest.json')),
        confirmRightsSha256: sha256File(path.join(directory, 'rights-manifest.json')),
        confirmTargetBucket: TARGET_BUCKET
    };
}

async function seedMediaControlPlane(pool, directory) {
    await pool.query('DELETE FROM public.s3_object_index');
    await pool.query('DELETE FROM public.s3_object_versions');
    const media = readJson(path.join(directory, 'media-manifest.json'));
    const entries = media.entries.filter((entry) => entry.disposition === 'store-protected');
    for (const entry of entries) {
        await pool.query(
            `INSERT INTO public.s3_object_versions
                (object_id, physical_key, storage_scope, byte_size, content_type,
                 sha256, etag, owner_token, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8)`,
            [
                entry.objectId,
                entry.physicalObjectKey,
                entry.storageScope,
                entry.bytes,
                entry.contentType,
                entry.sha256,
                entry.targetEtag,
                Date.parse('2026-07-17T00:00:00.000Z')
            ]
        );
        await pool.query(
            `INSERT INTO public.s3_object_index
                (logical_key, object_id, state, incarnation, operation_id, updated_at)
             VALUES ($1, $2, $3, 1, NULL, $4)`,
            [
                entry.logicalObjectKey,
                entry.objectId,
                entry.state,
                Date.parse('2026-07-17T00:00:00.000Z')
            ]
        );
    }
    return entries;
}

async function createSourceFixture(t, options = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ims-fudaba-metadata-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, 'source.sqlite');
    const database = open(source);
    await exec(database, SOURCE_SCHEMA);
    const created = '2026-07-15T01:02:03.000Z';
    const updated = '2026-07-16T02:03:04.000Z';
    await run(database, `INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?)`, [
        'account-a', 'Alice', options.externalAvatar || '/media/account-a.png',
        '上海', created, 'Alice bio', updated
    ]);
    await run(database, `INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?)`, [
        'account-b', 'Bob', options.emptyAvatar ? '' : '/media/account-b.png',
        '东京', created, 'Bob bio', updated
    ]);
    await run(database, `INSERT INTO oauth_accounts VALUES (?, ?, ?, ?, ?, ?, ?)`, [
        'google', 'google-alice', 'account-a', 'alice-google',
        'https://images.example/alice.png', created, updated
    ]);
    if (options.duplicateProviderForAccount) {
        await run(database, `INSERT INTO oauth_accounts VALUES (?, ?, ?, ?, ?, ?, ?)`, [
            'google', 'google-alice-second', 'account-a', 'alice-google-2',
            'https://images.example/alice-2.png', created, updated
        ]);
    }
    await run(database, `INSERT INTO sessions VALUES (?, ?, ?, ?)`, [
        SESSION_CANARY, 'account-a', '2026-08-15T00:00:00.000Z', created
    ]);
    await run(database, `INSERT INTO oauth_states VALUES (?, ?, ?, ?, ?, ?)`, [
        STATE_CANARY, 'google', VERIFIER_CANARY, 'account-a',
        '2026-08-15T00:00:00.000Z', created
    ]);
    await run(database, `INSERT INTO email_credentials VALUES (?, ?, ?, ?, ?, ?)`, [
        ' Bob@Example.COM ', 'account-b', PASSWORD_CANARY, SALT_CANARY, created, updated
    ]);
    await run(database, `INSERT INTO offices VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        'office-a', 'shanghai-office', 'account-a', '上海事务所', 'intro', '上海',
        '徐汇区', options.invalidLatitude ? 120 : 31.2304, 121.4737, '#ef5b6c',
        '/media/office-a.png', 1, 42, created, null,
        options.nullOfficeUpdatedAt ? null : updated
    ]);
    for (const value of SERIES) await run(database, 'INSERT INTO series_tags VALUES (?)', [value]);
    await run(database, 'INSERT INTO office_series_tags VALUES (?, ?, ?)', [
        'office-a', '灰姑娘女孩', 0
    ]);
    await run(database, `INSERT INTO cards VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        'card-wanted', 'account-b', 'Bob P', 'Bob Card', '灰姑娘女孩', '凛',
        '/media/card-wanted-front.png', '/media/card-wanted-back.png', '#4f64dd',
        'bio', 'trade', 1, created, null, null, null
    ]);
    await run(database, `INSERT INTO cards VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        'card-offered', 'account-a', 'Alice P', 'Alice Card', '闪耀色彩', '灯织',
        '/media/card-offered-front.png', '/media/card-offered-back.png', '#536ea8',
        'bio', 'trade', 1, created, 'https://example.com/card', 'source', 'owner'
    ]);
    await run(database, 'INSERT INTO office_cards VALUES (?, ?, ?, ?, ?, ?, ?)', [
        'office-a', 'card-wanted', created, 50, 50, 0, 1
    ]);
    await run(database, 'INSERT INTO messages VALUES (?, ?, ?, ?, ?)', [
        'message-a', 'office-a', 'account-a', 'Welcome', created
    ]);
    await run(database, `INSERT INTO exchange_requests VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        'exchange-a', 'office-a', 'account-a', 'account-b', 'card-wanted',
        options.invalidExchangeOwnership ? 'card-wanted' : 'card-offered',
        'Trade?', 'pending', created, updated
    ]);
    await run(database, 'INSERT INTO card_likes VALUES (?, ?, ?)', [
        'card-wanted', 'account-a', created
    ]);
    await run(database, 'INSERT INTO card_favorites VALUES (?, ?, ?)', [
        'card-wanted', 'account-a', created
    ]);
    if (options.archivedOffice) {
        await run(database, `
            UPDATE offices
            SET archived_at = ?, updated_at = ?
            WHERE id = 'office-a'
        `, [updated, updated]);
    }
    await close(database);
    return { root, source };
}

async function createApprovedSnapshot(t, options = {}) {
    const fixture = await createSourceFixture(t, options);
    const sourceHashBefore = sha256(fs.readFileSync(fixture.source));
    const result = await extractSnapshot({
        source: fixture.source,
        snapshotId: options.snapshotId || 'fixture-snapshot',
        snapshotRoot: fixture.root,
        d1DatabaseId: 'e585a1b9-16dd-460a-92b2-94f0017a1ead',
        r2Bucket: 'imas-world-card-images',
        appVersion: '0.1.0',
        exportTime: '2026-07-16T03:04:05.000Z',
        fudabaCommit: FUDABA_COMMIT
    });
    assert.equal(sha256(fs.readFileSync(fixture.source)), sourceHashBefore);
    const directory = result.snapshotDirectory;
    const rowsManifest = readJson(path.join(directory, 'rows-manifest.json'));
    for (const [table, rows] of Object.entries(rowsManifest.tables)) {
        if (!Array.isArray(rows)) continue;
        for (const descriptor of rows) {
            descriptor.classification = ['sessions', 'oauth_states'].includes(table)
                ? 'demo-or-synthetic'
                : 'production-user-content';
        }
    }
    writeJson(path.join(directory, 'rows-manifest.json'), rowsManifest);

    const entries = [
        mediaEntry(
            'account', 'account-a', 'avatar',
            options.externalAvatar || '/media/account-a.png'
        ),
        ...(options.emptyAvatar
            ? []
            : [mediaEntry('account', 'account-b', 'avatar', '/media/account-b.png')]),
        mediaEntry('office', 'office-a', 'cover', '/media/office-a.png'),
        mediaEntry('card', 'card-wanted', 'front', '/media/card-wanted-front.png'),
        mediaEntry('card', 'card-wanted', 'back', '/media/card-wanted-back.png'),
        mediaEntry('card', 'card-offered', 'front', '/media/card-offered-front.png'),
        mediaEntry('card', 'card-offered', 'back', '/media/card-offered-back.png')
    ];
    const sourceInventorySha256 = sha256('fixture-source-inventory');
    if (options.externalAvatar) {
        const avatar = entries.find((entry) =>
            entry.entityKind === 'account' && entry.entityId === 'account-a' &&
            entry.slot === 'avatar');
        Object.assign(avatar, {
            logicalObjectKey: null,
            state: 'external',
            disposition: 'retain-external',
            storageScope: null,
            targetBucket: null,
            objectId: null,
            physicalObjectKey: null,
            targetEtag: null,
            bytes: null,
            contentType: null,
            sha256: null,
            readbackSha256: null,
            externalUrl: options.externalAvatar
        });
    }
    if (options.omitOfficeCover) {
        const cover = entries.find((entry) =>
            entry.entityKind === 'office' && entry.entityId === 'office-a' &&
            entry.slot === 'cover');
        Object.assign(cover, {
            state: 'omitted',
            disposition: 'omit',
            storageScope: null,
            targetBucket: null,
            objectId: null,
            physicalObjectKey: null,
            targetEtag: null,
            readbackSha256: null
        });
    }
    const planEntries = entries.map((entry) => {
        const external = entry.state === 'external';
        const required = entry.entityKind === 'card';
        const planned = {
            entityKind: entry.entityKind,
            entityId: entry.entityId,
            slot: entry.slot,
            required,
            sourceReference: entry.sourceReference,
            sourceType: external ? 'external' : 'r2',
            requestedAction: external ? 'retain-external' : 'store-protected',
            logicalObjectKey: entry.logicalObjectKey,
            sourceObject: external ? null : {
                key: entry.sourceReference.replace(/^\/media\//, ''),
                versionId: null,
                etag: `source-${entry.entityKind}-${entry.entityId}-${entry.slot}`,
                bytes: entry.bytes,
                contentType: entry.contentType,
                sha256: entry.sha256,
                metadataSha256: sha256(
                    `metadata:${entry.entityKind}:${entry.entityId}:${entry.slot}`
                )
            },
            image: external ? null : {
                format: 'png',
                width: 8,
                height: 8,
                contentType: entry.contentType
            },
            blocker: null
        };
        const bindingSha256 = canonicalHash(planned);
        entry.bindingSha256 = bindingSha256;
        return { ...planned, bindingSha256 };
    });
    const mediaPlan = {
        schemaVersion: 2,
        snapshotId: rowsManifest.snapshotId,
        sourceSha256: rowsManifest.sourceSha256,
        sourceCommit: FUDABA_COMMIT,
        sourceBucket: 'imas-world-card-images',
        sourceInventorySha256,
        entries: planEntries
    };
    writeJson(path.join(directory, 'media-plan.json'), mediaPlan);
    const mediaPlanSha256 = sha256File(path.join(directory, 'media-plan.json'));
    const identity = {
        schemaVersion: 2,
        snapshotId: rowsManifest.snapshotId,
        sourceSha256: rowsManifest.sourceSha256,
        version: 1,
        mediaPlanSha256
    };
    writeJson(path.join(directory, 'media-manifest.json'), {
        ...identity,
        sourceInventorySha256,
        entries
    });
    writeJson(path.join(directory, 'rights-manifest.json'), {
        ...identity,
        approvals: entries.map((entry) => ({
            entityKind: entry.entityKind,
            entityId: entry.entityId,
            slot: entry.slot,
            sourceReference: entry.sourceReference,
            logicalObjectKey: entry.logicalObjectKey,
            bindingSha256: entry.bindingSha256,
            sourceSha256: entry.sha256,
            bytes: entry.bytes,
            contentType: entry.contentType,
            status: entry.state === 'omitted' ? 'denied' : 'approved',
            action: entry.state === 'omitted'
                ? 'omit'
                : entry.state === 'external'
                    ? 'retain-external'
                    : 'store-protected',
            reviewedBy: 'fixture-reviewer',
            reviewedAt: '2026-07-16T03:04:05.000Z',
            evidenceSha256: sha256(`evidence:${entry.bindingSha256}`)
        }))
    });
    return { ...fixture, directory, sourceHashBefore };
}

function poolFor(databaseUrl) {
    return new Pool({ connectionString: databaseUrl, max: 1, allowExitOnIdle: true });
}

test('timestamp and series conversion accept only the locked source contract', () => {
    assert.equal(
        parseTimestamp('2026-07-15 01:02:03', 'created_at').iso,
        '2026-07-15T01:02:03.000Z'
    );
    assert.equal(mapSeries('vα-liv').code, null);
    assert.notEqual(mapSeries('vα-liv').code, '876');
    assert.equal(mapSeries('本家 / 765AS').code, '765');
    assert.throws(() => mapSeries('  SideM  '), /Unknown Fudaba series/);
    assert.throws(() => parseTimestamp('2026-02-31T00:00:00Z', 'created_at'), /invalid/);
    assert.throws(() => parseTimestamp(' 2026-02-01T00:00:00Z', 'created_at'), /invalid/);
    assert.throws(() => parseTimestamp('2026-02-01T00:00:00.0001Z', 'created_at'), /ISO\/SQLite/);
    assert.throws(() => parseTimestamp('now', 'created_at'), /ISO\/SQLite/);
});

test('extract creates an immutable, classified snapshot without leaking security rows', async (t) => {
    const fixture = await createSourceFixture(t);
    const sourceHash = sha256(fs.readFileSync(fixture.source));
    await assert.rejects(() => extractSnapshot({
        source: fixture.source,
        snapshotId: 'missing-commit'
    }), /Fudaba commit must be/);
    const result = await extractSnapshot({
        source: fixture.source,
        snapshotId: 'extract-contract',
        snapshotRoot: fixture.root,
        d1DatabaseId: 'e585a1b9-16dd-460a-92b2-94f0017a1ead',
        r2Bucket: 'imas-world-card-images',
        appVersion: '0.1.0',
        exportTime: '2026-07-16T03:04:05.000Z',
        fudabaCommit: FUDABA_COMMIT
    });
    assert.equal(sha256(fs.readFileSync(fixture.source)), sourceHash);
    for (const filename of [
        'source.json', 'database.sqlite', 'rows-manifest.json',
        'media-manifest.json', 'rights-manifest.json', 'reconciliation.json'
    ]) {
        const artifact = path.join(result.snapshotDirectory, filename);
        assert.equal(fs.existsSync(artifact), true, filename);
        assert.equal(fs.statSync(artifact).mode & 0o777, 0o600, `${filename} mode`);
    }
    const source = readJson(path.join(result.snapshotDirectory, 'source.json'));
    assert.equal(source.source.commit, FUDABA_COMMIT);
    assert.deepEqual(source.source.migrations, FUDABA_MIGRATIONS);
    assert.equal(source.sourceExport.sha256, sourceHash);
    assert.notEqual(source.database.sha256, sourceHash);
    const rows = readJson(path.join(result.snapshotDirectory, 'rows-manifest.json'));
    assert.equal(rows.summary.total, 22);
    assert.equal(rows.summary.classifications.unknown, 22);
    assert.equal(rows.summary.operationalRowsExcluded, 2);
    assert.deepEqual(rows.tables.sessions, {
        count: 1,
        migrated: false,
        redactedFromSnapshot: true
    });
    assert.deepEqual(rows.tables.oauth_states, {
        count: 1,
        migrated: false,
        redactedFromSnapshot: true
    });
    const redactedDatabase = fs.readFileSync(
        path.join(result.snapshotDirectory, 'database.sqlite')
    );
    for (const secret of [SESSION_CANARY, STATE_CANARY, VERIFIER_CANARY]) {
        assert.equal(redactedDatabase.includes(Buffer.from(secret)), false, secret);
    }
    const auditText = [
        'source.json', 'rows-manifest.json', 'media-manifest.json',
        'rights-manifest.json', 'reconciliation.json'
    ].map((filename) => fs.readFileSync(path.join(result.snapshotDirectory, filename), 'utf8'))
        .join('\n');
    for (const secret of [
        SESSION_CANARY, STATE_CANARY, VERIFIER_CANARY, PASSWORD_CANARY, SALT_CANARY
    ]) assert.equal(auditText.includes(secret), false, secret);
});

test('planning preserves count provenance and excludes ephemeral auth state', async (t) => {
    const snapshot = await createApprovedSnapshot(t);
    const plan = await buildImportPlan(snapshot.directory);
    assert.deepEqual(plan.summary, { included: 20, excluded: 2, failed: 0 });
    assert.deepEqual(plan.sourceTables.sessions, {
        source: 1,
        included: 0,
        excluded: 1,
        failed: 0
    });
    for (const table of Object.values(plan.sourceTables)) {
        assert.equal(table.source, table.included + table.excluded + table.failed);
    }
    assert.equal(plan.operations.length, 21);
    assert.equal(plan.operations.some(({ table }) =>
        ['platform_oauth_states', 'platform_refresh_sessions'].includes(table)), false);
    const office = plan.rows.find(({ sourceTable }) => sourceTable === 'offices');
    assert.deepEqual(office.visitorCount, {
        source: 42,
        imported: 0,
        verifiedProductionCount: false,
        evidence: null
    });
    const serialized = JSON.stringify({ rows: plan.rows, operations: plan.operations.map(
        ({ row, ...operation }) => ({ ...operation, row: Object.fromEntries(
            Object.entries(row).filter(([key]) => !['password_hash', 'salt'].includes(key))
        ) })
    ) });
    for (const secret of [SESSION_CANARY, STATE_CANARY, VERIFIER_CANARY]) {
        assert.equal(serialized.includes(secret), false);
    }
});

test('planning handles source-null update times and empty optional avatars exactly', async (t) => {
    const snapshot = await createApprovedSnapshot(t, {
        snapshotId: 'nullable-source-fields',
        emptyAvatar: true,
        nullOfficeUpdatedAt: true
    });
    const plan = await buildImportPlan(snapshot.directory);
    const profile = plan.operations.find(({ table, row }) =>
        table === 'platform_profiles' && row.account_id === 'account-b');
    const office = plan.operations.find(({ table }) => table === 'fudaba_offices');
    assert.equal(profile.row.avatar_object_key, null);
    assert.equal(profile.row.avatar_external_url, null);
    assert.equal(office.row.updated_at, office.row.created_at);
});

test('planning consumes explicitly retained external avatars and denied optional covers', async (t) => {
    const externalAvatar = 'https://images.example/alice-retained.png';
    const snapshot = await createApprovedSnapshot(t, {
        snapshotId: 'optional-media-dispositions',
        externalAvatar,
        omitOfficeCover: true
    });
    const plan = await buildImportPlan(snapshot.directory);
    assert.equal(plan.summary.failed, 0);
    const profile = plan.operations.find(({ table, row }) =>
        table === 'platform_profiles' && row.account_id === 'account-a');
    const office = plan.operations.find(({ table }) => table === 'fudaba_offices');
    assert.equal(profile.row.avatar_object_key, null);
    assert.equal(profile.row.avatar_external_url, externalAvatar);
    assert.equal(office.row.cover_object_key, null);
});

test('planning rejects public media and a manifest detached from its media plan', async (t) => {
    const publicSnapshot = await createApprovedSnapshot(t, {
        snapshotId: 'public-media-rejected'
    });
    const publicFile = path.join(publicSnapshot.directory, 'media-manifest.json');
    const publicManifest = readJson(publicFile);
    const publicEntry = publicManifest.entries.find((entry) =>
        entry.entityKind === 'card' && entry.entityId === 'card-wanted' &&
        entry.slot === 'back');
    publicEntry.storageScope = 'public';
    writeJson(publicFile, publicManifest);
    const publicPlan = await buildImportPlan(publicSnapshot.directory);
    assert.equal(publicPlan.summary.failed > 0, true);
    assert.equal(publicPlan.blockers.some(({ reason }) =>
        reason.includes('Media is not verified ready')), true);

    const detachedSnapshot = await createApprovedSnapshot(t, {
        snapshotId: 'detached-media-plan'
    });
    const detachedFile = path.join(detachedSnapshot.directory, 'media-manifest.json');
    const detachedManifest = readJson(detachedFile);
    detachedManifest.entries[0].bindingSha256 = sha256('tampered-binding');
    writeJson(detachedFile, detachedManifest);
    await assert.rejects(
        () => buildImportPlan(detachedSnapshot.directory),
        /media manifest entry does not match the media plan/
    );
});

test('planning recomputes every media-plan binding after a plan reseal', async (t) => {
    const snapshot = await createApprovedSnapshot(t, {
        snapshotId: 'recomputed-media-binding'
    });
    const planFile = path.join(snapshot.directory, 'media-plan.json');
    const plan = readJson(planFile);
    plan.entries[0].image.width += 1;
    writeJson(planFile, plan);
    const resealedPlanSha256 = sha256File(planFile);
    for (const filename of ['media-manifest.json', 'rights-manifest.json']) {
        const artifactFile = path.join(snapshot.directory, filename);
        const artifact = readJson(artifactFile);
        artifact.mediaPlanSha256 = resealedPlanSha256;
        writeJson(artifactFile, artifact);
    }
    await assert.rejects(
        () => buildImportPlan(snapshot.directory),
        /media plan binding SHA-256 is invalid/
    );
});

test('extract rejects schema drift and classification keys absent from the source', async (t) => {
    const schemaDrift = await createSourceFixture(t);
    const database = open(schemaDrift.source);
    await exec(database, 'CREATE TABLE unexpected_application_table (id TEXT)');
    await close(database);
    await assert.rejects(() => extractSnapshot({
        source: schemaDrift.source,
        snapshotId: 'schema-drift',
        snapshotRoot: schemaDrift.root,
        d1DatabaseId: 'e585a1b9-16dd-460a-92b2-94f0017a1ead',
        r2Bucket: 'imas-world-card-images',
        appVersion: '0.1.0',
        exportTime: '2026-07-16T03:04:05.000Z',
        fudabaCommit: FUDABA_COMMIT
    }), /Unexpected Fudaba source table/);

    const classificationDrift = await createSourceFixture(t);
    await assert.rejects(() => extractSnapshot({
        source: classificationDrift.source,
        snapshotId: 'classification-drift',
        snapshotRoot: classificationDrift.root,
        d1DatabaseId: 'e585a1b9-16dd-460a-92b2-94f0017a1ead',
        r2Bucket: 'imas-world-card-images',
        appVersion: '0.1.0',
        exportTime: '2026-07-16T03:04:05.000Z',
        fudabaCommit: FUDABA_COMMIT,
        classifications: [{
            table: 'users',
            key: { id: 'missing-account' },
            classification: 'production-user-content'
        }]
    }), /do not match source rows/);
});

test('extract rejects migration-ledger, index and trigger provenance drift', async (t) => {
    const fixtures = await Promise.all([
        createSourceFixture(t),
        createSourceFixture(t),
        createSourceFixture(t)
    ]);
    const mutations = [
        "UPDATE d1_migrations SET name = '0001_rewritten.sql' WHERE id = 1",
        'DROP INDEX offices_city_idx',
        'DROP TRIGGER messages_require_active_insert'
    ];
    const patterns = [/migration ledger/, /indexes/, /triggers/];
    for (let index = 0; index < fixtures.length; index += 1) {
        const fixture = fixtures[index];
        const database = open(fixture.source);
        await exec(database, mutations[index]);
        await close(database);
        await assert.rejects(() => extractSnapshot({
            source: fixture.source,
            snapshotId: `provenance-drift-${index}`,
            snapshotRoot: fixture.root,
            d1DatabaseId: 'e585a1b9-16dd-460a-92b2-94f0017a1ead',
            r2Bucket: 'imas-world-card-images',
            appVersion: '0.1.0',
            exportTime: '2026-07-16T03:04:05.000Z',
            fudabaCommit: FUDABA_COMMIT
        }), patterns[index]);
    }
});

test('extract rejects full table, trigger and ledger DDL rewrites', async (t) => {
    const fixtures = await Promise.all([
        createSourceFixture(t),
        createSourceFixture(t),
        createSourceFixture(t)
    ]);
    const mutations = [
        `
            DROP INDEX email_credentials_user_idx;
            DROP TABLE email_credentials;
            CREATE TABLE email_credentials (
                email TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                salt TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX email_credentials_user_idx ON email_credentials(user_id);
        `,
        `
            DROP TRIGGER messages_require_active_insert;
            CREATE TRIGGER messages_require_active_insert
            BEFORE INSERT ON messages
            WHEN (SELECT archived_at FROM offices WHERE id = NEW.office_id) IS NOT NULL AND 0
            BEGIN
                SELECT RAISE(ABORT, 'OFFICE_ARCHIVED');
            END;
        `,
        `
            DROP TABLE d1_migrations;
            CREATE TABLE "d1_migrations"(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT,
                applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
            );
            INSERT INTO d1_migrations (name) VALUES
                ('0001_initial.sql'),
                ('0002_official_demo_card_art.sql'),
                ('0003_public_card_users.sql'),
                ('0004_interactive_card_wall.sql'),
                ('0005_oauth_profiles.sql'),
                ('0006_office_series_tags.sql'),
                ('0007_office_management.sql'),
                ('0008_series_office_covers.sql'),
                ('0009_card_interactions.sql'),
                ('0010_email_credentials.sql');
        `
    ];
    const patterns = [
        /source table DDL drift: email_credentials/,
        /source trigger DDL drift: messages_require_active_insert/,
        /source table DDL drift: d1_migrations/
    ];
    for (let index = 0; index < fixtures.length; index += 1) {
        const fixture = fixtures[index];
        const database = open(fixture.source);
        await exec(database, mutations[index]);
        await close(database);
        await assert.rejects(() => extractSnapshot({
            source: fixture.source,
            snapshotId: `full-ddl-drift-${index}`,
            snapshotRoot: fixture.root,
            d1DatabaseId: 'e585a1b9-16dd-460a-92b2-94f0017a1ead',
            r2Bucket: 'imas-world-card-images',
            appVersion: '0.1.0',
            exportTime: '2026-07-16T03:04:05.000Z',
            fudabaCommit: FUDABA_COMMIT
        }), patterns[index]);
    }
});

test('apply confirmation seals source.json independently from the source export', async (t) => {
    const snapshot = await createApprovedSnapshot(t, { snapshotId: 'source-manifest-seal' });
    const confirmations = snapshotConfirmations(snapshot.directory);
    const sourceFile = path.join(snapshot.directory, 'source.json');
    const source = readJson(sourceFile);
    source.source.appVersion = 'tampered-after-approval';
    writeJson(sourceFile, source);
    await assert.rejects(() => importSnapshot({
        snapshotDirectory: snapshot.directory,
        connectionString: 'postgresql://unused:unused@127.0.0.1:1/unused',
        targetBucket: TARGET_BUCKET,
        apply: true,
        ...confirmations
    }), /confirm-source-manifest-sha256/);
});

test('planning rejects tampered operational-row provenance', async (t) => {
    const snapshot = await createApprovedSnapshot(t, {
        snapshotId: 'operational-count-provenance'
    });
    const sourceFile = path.join(snapshot.directory, 'source.json');
    const source = readJson(sourceFile);
    source.validation.operationalRows.sessions.sourceCount += 1;
    writeJson(sourceFile, source);
    await assert.rejects(
        () => buildImportPlan(snapshot.directory),
        /Operational row provenance mismatch for sessions/
    );
});

test('planning rejects values that only PostgreSQL would otherwise catch', async (t) => {
    const invalidLocation = await createApprovedSnapshot(t, {
        snapshotId: 'invalid-location',
        invalidLatitude: true
    });
    const locationPlan = await buildImportPlan(invalidLocation.directory);
    assert.equal(locationPlan.blockers.some(({ sourceTable }) => sourceTable === 'offices'), true);
    assert.equal(locationPlan.blockers.find(({ sourceTable }) =>
        sourceTable === 'offices').reasonCode, 'source-row-invalid');

    const duplicateProvider = await createApprovedSnapshot(t, {
        snapshotId: 'duplicate-provider',
        duplicateProviderForAccount: true
    });
    const providerPlan = await buildImportPlan(duplicateProvider.directory);
    assert.equal(providerPlan.blockers.some(({ sourceTable, reason }) =>
        sourceTable === 'oauth_accounts' && reason.includes('provider')), true);

    const invalidExchange = await createApprovedSnapshot(t, {
        snapshotId: 'invalid-exchange',
        invalidExchangeOwnership: true
    });
    const exchangePlan = await buildImportPlan(invalidExchange.directory);
    assert.equal(exchangePlan.blockers.some(({ sourceTable }) =>
        sourceTable === 'exchange_requests'), true);
});

test('real PostgreSQL dry-run, apply, repeat and reconciliation are exact', {
    skip: !postgresIntegrationEnabled()
}, async (t) => {
    const harness = await createPostgresTestHarness();
    let pool;
    t.after(async () => {
        await pool?.end();
        await harness.close();
    });
    const snapshot = await createApprovedSnapshot(t, { snapshotId: 'postgres-apply' });
    pool = poolFor(harness.databaseUrl);
    await seedMediaControlPlane(pool, snapshot.directory);
    const dryRun = await importSnapshot({
        snapshotDirectory: snapshot.directory,
        connectionString: harness.databaseUrl,
        targetBucket: TARGET_BUCKET
    });
    assert.equal(dryRun.committed, false);
    assert.equal(dryRun.summary.missing, 15);
    assert.equal(dryRun.summary.unchanged, 6);
    assert.deepEqual(dryRun.artifactSha256, {
        source: sha256File(path.join(snapshot.directory, 'source.json')),
        rows: sha256File(path.join(snapshot.directory, 'rows-manifest.json')),
        mediaPlan: sha256File(path.join(snapshot.directory, 'media-plan.json')),
        media: sha256File(path.join(snapshot.directory, 'media-manifest.json')),
        rights: sha256File(path.join(snapshot.directory, 'rights-manifest.json'))
    });

    assert.equal(Number((await pool.query('SELECT COUNT(*) FROM platform_accounts')).rows[0].count), 0);

    const confirmations = snapshotConfirmations(snapshot.directory);
    await assert.rejects(() => importSnapshot({
        snapshotDirectory: snapshot.directory,
        connectionString: harness.databaseUrl,
        targetBucket: TARGET_BUCKET,
        apply: true,
        confirmSnapshotId: confirmations.confirmSnapshotId,
        confirmSourceSha256: confirmations.confirmSourceSha256
    }), /confirm-source-manifest-sha256/);
    const applied = await importSnapshot({
        snapshotDirectory: snapshot.directory,
        connectionString: harness.databaseUrl,
        targetBucket: TARGET_BUCKET,
        apply: true,
        ...confirmations
    });
    assert.equal(applied.committed, true);
    assert.equal(applied.summary.inserted, 15);
    const repeated = await importSnapshot({
        snapshotDirectory: snapshot.directory,
        connectionString: harness.databaseUrl,
        targetBucket: TARGET_BUCKET,
        apply: true,
        ...confirmations
    });
    assert.equal(repeated.summary.inserted, 0);
    assert.equal(repeated.summary.unchanged, 21);
    const reconciled = await reconcileSnapshot({
        snapshotDirectory: snapshot.directory,
        connectionString: harness.databaseUrl,
        targetBucket: TARGET_BUCKET,
        write: false
    });
    assert.equal(reconciled.status, 'passed');
    assert.equal(reconciled.targetTables.fudaba_messages.states.unchanged, 1);

    const credential = (await pool.query(
        'SELECT algorithm, parameters_json, password_hash, salt FROM platform_email_credentials'
    )).rows[0];
    assert.equal(credential.algorithm, 'pbkdf2-sha256');
    assert.equal(credential.password_hash, PASSWORD_CANARY);
    assert.equal(credential.salt, SALT_CANARY);
    assert.deepEqual(JSON.parse(credential.parameters_json), {
        iterations: 100000,
        hash: 'sha256',
        keyLength: 32,
        encoding: 'hex',
        saltEncoding: 'utf8'
    });
    assert.equal(Number((await pool.query('SELECT COUNT(*) FROM platform_oauth_states')).rows[0].count), 0);
    assert.equal(Number((await pool.query('SELECT COUNT(*) FROM platform_refresh_sessions')).rows[0].count), 0);

    await pool.query("UPDATE fudaba_messages SET content='drift' WHERE id='message-a'");
    const drift = await reconcileSnapshot({
        snapshotDirectory: snapshot.directory,
        connectionString: harness.databaseUrl,
        targetBucket: TARGET_BUCKET,
        write: false
    });
    assert.equal(drift.status, 'failed');
    assert.equal(drift.summary.different, 1);
    assert.deepEqual(
        drift.targets.find(({ table, state }) => table === 'fudaba_messages' && state === 'different')
            .differentColumns,
        ['content']
    );
});

test('real PostgreSQL blocks missing or drifted media control-plane state', {
    skip: !postgresIntegrationEnabled()
}, async (t) => {
    const harness = await createPostgresTestHarness();
    const pool = poolFor(harness.databaseUrl);
    t.after(async () => {
        await pool.end();
        await harness.close();
    });
    const snapshot = await createApprovedSnapshot(t, {
        snapshotId: 'postgres-media-control-plane'
    });
    const cases = [
        {
            name: 'missing',
            column: 'logicalObjectKey',
            mutate: (entry) => pool.query(
                'DELETE FROM public.s3_object_index WHERE logical_key=$1',
                [entry.logicalObjectKey]
            )
        },
        {
            name: 'public',
            column: 'storageScope',
            mutate: (entry) => pool.query(
                "UPDATE public.s3_object_versions SET storage_scope='public' WHERE object_id=$1",
                [entry.objectId]
            )
        },
        {
            name: 'pending',
            column: 'state',
            mutate: (entry) => pool.query(
                "UPDATE public.s3_object_index SET state='pending' WHERE logical_key=$1",
                [entry.logicalObjectKey]
            )
        },
        {
            name: 'object-id',
            column: 'objectId',
            async mutate(entry) {
                await pool.query(
                    `INSERT INTO public.s3_object_versions
                        (object_id, physical_key, storage_scope, byte_size, content_type,
                         sha256, etag, owner_token, created_at)
                     SELECT $1, physical_key || '-drift', storage_scope, byte_size,
                            content_type, sha256, etag, owner_token, created_at
                     FROM public.s3_object_versions WHERE object_id=$2`,
                    ['drift-object-id', entry.objectId]
                );
                await pool.query(
                    'UPDATE public.s3_object_index SET object_id=$1 WHERE logical_key=$2',
                    ['drift-object-id', entry.logicalObjectKey]
                );
            }
        },
        {
            name: 'physical-key',
            column: 'physicalObjectKey',
            mutate: (entry) => pool.query(
                "UPDATE public.s3_object_versions SET physical_key=physical_key || '-drift' WHERE object_id=$1",
                [entry.objectId]
            )
        },
        {
            name: 'byte-size',
            column: 'byteSize',
            mutate: (entry) => pool.query(
                'UPDATE public.s3_object_versions SET byte_size=byte_size + 1 WHERE object_id=$1',
                [entry.objectId]
            )
        },
        {
            name: 'content-type',
            column: 'contentType',
            mutate: (entry) => pool.query(
                "UPDATE public.s3_object_versions SET content_type='image/webp' WHERE object_id=$1",
                [entry.objectId]
            )
        },
        {
            name: 'sha256',
            column: 'sha256',
            mutate: (entry) => pool.query(
                'UPDATE public.s3_object_versions SET sha256=$1 WHERE object_id=$2',
                ['f'.repeat(64), entry.objectId]
            )
        },
        {
            name: 'etag',
            column: 'etag',
            mutate: (entry) => pool.query(
                "UPDATE public.s3_object_versions SET etag=etag || '-drift' WHERE object_id=$1",
                [entry.objectId]
            )
        }
    ];
    for (const scenario of cases) {
        const [entry] = await seedMediaControlPlane(pool, snapshot.directory);
        await scenario.mutate(entry);
        await assert.rejects(() => importSnapshot({
            snapshotDirectory: snapshot.directory,
            connectionString: harness.databaseUrl,
            targetBucket: TARGET_BUCKET
        }), (error) => {
            assert.match(error.message, /media target conflict/);
            assert.equal(error.report.summary.mediaConflicts, 1, scenario.name);
            const target = error.report.mediaTargets.find((candidate) =>
                candidate.logicalObjectKey === entry.logicalObjectKey);
            assert.ok(target.differentColumns.includes(scenario.column), scenario.name);
            return true;
        });
    }
    assert.equal(Number((await pool.query(
        'SELECT COUNT(*) FROM platform_accounts'
    )).rows[0].count), 0);
});

test('real PostgreSQL reports alternate unique-key conflicts before writing', {
    skip: !postgresIntegrationEnabled()
}, async (t) => {
    const harness = await createPostgresTestHarness();
    const pool = poolFor(harness.databaseUrl);
    t.after(async () => {
        await pool.end();
        await harness.close();
    });
    const snapshot = await createApprovedSnapshot(t, { snapshotId: 'postgres-unique-conflict' });
    await seedMediaControlPlane(pool, snapshot.directory);
    await pool.query(`
        INSERT INTO platform_accounts
            (id, status, token_version, created_at, updated_at, deleted_at)
        VALUES ('existing-account', 'active', 0, 1, 1, NULL);
        INSERT INTO fudaba_offices (
            id, owner_account_id, slug, name, intro, city, address,
            latitude, longitude, accent, cover_object_key, is_open,
            visitor_count, status, revision, created_at, updated_at, archived_at
        ) VALUES (
            'existing-office', 'existing-account', 'shanghai-office', 'Existing', '',
            '上海', 'Existing address', 31, 121, '#ef5b6c', NULL, TRUE,
            0, 'active', 0, '2026-07-15T01:02:03.000Z',
            '2026-07-15T01:02:03.000Z', NULL
        );
    `);
    await assert.rejects(() => importSnapshot({
        snapshotDirectory: snapshot.directory,
        connectionString: harness.databaseUrl,
        targetBucket: TARGET_BUCKET
    }), (error) => {
        const conflict = error.report.targets.find(({ table, state }) =>
            table === 'fudaba_offices' && state === 'conflict');
        assert.deepEqual(conflict.differentColumns, ['unique:slug']);
        assert.equal(error.report.summary.conflicts, 1);
        return true;
    });
    assert.equal(Number((await pool.query(
        "SELECT COUNT(*) FROM platform_accounts WHERE id = 'account-a'"
    )).rows[0].count), 0);
});

test('real PostgreSQL imports historical children before restoring an archived office', {
    skip: !postgresIntegrationEnabled()
}, async (t) => {
    const harness = await createPostgresTestHarness();
    const pool = poolFor(harness.databaseUrl);
    t.after(async () => {
        await pool.end();
        await harness.close();
    });
    const snapshot = await createApprovedSnapshot(t, {
        snapshotId: 'postgres-archived-office',
        archivedOffice: true
    });
    await seedMediaControlPlane(pool, snapshot.directory);
    const applied = await importSnapshot({
        snapshotDirectory: snapshot.directory,
        connectionString: harness.databaseUrl,
        targetBucket: TARGET_BUCKET,
        apply: true,
        ...snapshotConfirmations(snapshot.directory)
    });
    assert.equal(applied.committed, true);
    const office = (await pool.query(
        "SELECT status, archived_at FROM fudaba_offices WHERE id = 'office-a'"
    )).rows[0];
    assert.equal(office.status, 'archived');
    assert.equal(office.archived_at.toISOString(), '2026-07-16T02:03:04.000Z');
    for (const table of ['fudaba_office_cards', 'fudaba_messages', 'fudaba_exchange_requests']) {
        assert.equal(Number((await pool.query(`SELECT COUNT(*) FROM ${table}`)).rows[0].count), 1);
    }
    const repeated = await importSnapshot({
        snapshotDirectory: snapshot.directory,
        connectionString: harness.databaseUrl,
        targetBucket: TARGET_BUCKET,
        apply: true,
        ...snapshotConfirmations(snapshot.directory)
    });
    assert.equal(repeated.summary.unchanged, 21);
    assert.equal(repeated.summary.inserted, 0);
    const reconciliation = await reconcileSnapshot({
        snapshotDirectory: snapshot.directory,
        connectionString: harness.databaseUrl,
        targetBucket: TARGET_BUCKET,
        write: false
    });
    assert.equal(reconciliation.status, 'passed');
});

test('real PostgreSQL reconciles a lost commit acknowledgement before reporting success', {
    skip: !postgresIntegrationEnabled()
}, async (t) => {
    const harness = await createPostgresTestHarness();
    const pool = poolFor(harness.databaseUrl);
    t.after(async () => {
        await pool.end();
        await harness.close();
    });
    const snapshot = await createApprovedSnapshot(t, {
        snapshotId: 'postgres-commit-acknowledgement'
    });
    await seedMediaControlPlane(pool, snapshot.directory);
    const recovered = await importSnapshot({
        snapshotDirectory: snapshot.directory,
        connectionString: harness.databaseUrl,
        targetBucket: TARGET_BUCKET,
        apply: true,
        ...snapshotConfirmations(snapshot.directory),
        afterCommitSent() {
            throw new Error('simulated lost commit acknowledgement');
        }
    });
    assert.equal(recovered.commitAttempted, true);
    assert.equal(recovered.commitOutcome, 'reconciled');
    assert.equal(recovered.outcomeUnknown, false);
    assert.equal(recovered.committed, true);
    assert.equal(recovered.rolledBack, false);
    assert.equal(recovered.reconciliation.status, 'passed');
    assert.equal(Number((await pool.query('SELECT COUNT(*) FROM platform_accounts')).rows[0].count), 2);
    assert.equal(Number((await pool.query('SELECT COUNT(*) FROM fudaba_messages')).rows[0].count), 1);
});

test('real PostgreSQL serializes concurrent identical applies into one exact dataset', {
    skip: !postgresIntegrationEnabled()
}, async (t) => {
    const harness = await createPostgresTestHarness();
    t.after(() => harness.close());
    const snapshot = await createApprovedSnapshot(t, { snapshotId: 'postgres-concurrent' });
    const seedPool = poolFor(harness.databaseUrl);
    await seedMediaControlPlane(seedPool, snapshot.directory);
    await seedPool.end();
    const options = {
        snapshotDirectory: snapshot.directory,
        connectionString: harness.databaseUrl,
        targetBucket: TARGET_BUCKET,
        apply: true,
        ...snapshotConfirmations(snapshot.directory)
    };
    const reports = await Promise.all([
        importSnapshot(options),
        importSnapshot(options)
    ]);
    assert.deepEqual(
        reports.map(({ summary }) => summary.inserted).sort((a, b) => a - b),
        [0, 15]
    );
    assert.equal(reports.every(({ committed }) => committed), true);

    const pool = poolFor(harness.databaseUrl);
    try {
        assert.equal(Number((await pool.query('SELECT COUNT(*) FROM platform_accounts')).rows[0].count), 2);
        assert.equal(Number((await pool.query('SELECT COUNT(*) FROM fudaba_cards')).rows[0].count), 2);
        assert.equal(Number((await pool.query('SELECT COUNT(*) FROM fudaba_exchange_requests')).rows[0].count), 1);
    } finally {
        await pool.end();
    }
});

test('real PostgreSQL rolls back the entire import after a late write failure', {
    skip: !postgresIntegrationEnabled()
}, async (t) => {
    const harness = await createPostgresTestHarness();
    const snapshot = await createApprovedSnapshot(t, { snapshotId: 'postgres-rollback' });
    const pool = poolFor(harness.databaseUrl);
    t.after(async () => {
        await pool.end();
        await harness.close();
    });
    await seedMediaControlPlane(pool, snapshot.directory);
    await pool.query(`
        CREATE FUNCTION fail_fudaba_like_import() RETURNS trigger AS $$
        BEGIN
            RAISE EXCEPTION 'test late import failure';
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER fail_fudaba_like_import
        BEFORE INSERT ON fudaba_card_likes
        FOR EACH ROW EXECUTE FUNCTION fail_fudaba_like_import();
    `);
    await assert.rejects(() => importSnapshot({
        snapshotDirectory: snapshot.directory,
        connectionString: harness.databaseUrl,
        targetBucket: TARGET_BUCKET,
        apply: true,
        ...snapshotConfirmations(snapshot.directory)
    }), /late import failure/);
    for (const table of [
        'platform_accounts', 'fudaba_offices', 'fudaba_cards', 'fudaba_messages'
    ]) {
        const result = await pool.query(`SELECT COUNT(*) FROM ${table}`);
        assert.equal(Number(result.rows[0].count), 0, table);
    }
});
