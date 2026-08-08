'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sharp = require('sharp');
const {
    FUDABA_COMMIT,
    FUDABA_D1_DATABASE_ID,
    FUDABA_R2_BUCKET,
    SOURCE_TABLES,
    canonicalHash,
    sha256File,
    sourceManifestKey
} = require('../../scripts/migration/fudaba-metadata');
const {
    FudabaMediaBlockedError,
    applyMissingTransfers,
    parseArguments,
    r2KeyFromLocator,
    runFudabaMediaMigration
} = require('../../scripts/migration/fudaba-media');

const SOURCE_SHA256 = 'a'.repeat(64);
const SNAPSHOT_ID = 'fixture-media-snapshot';
const FRONT_KEY = 'cards/account-a/11111111-1111-4111-8111-111111111111-front.png';
const BACK_KEY = 'cards/account-a/22222222-2222-4222-8222-222222222222-back.png';

function digest(body) {
    return crypto.createHash('sha256').update(body).digest('hex');
}

function writeJson(filename, value) {
    fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function emptyRows() {
    return Object.fromEntries(Object.keys(SOURCE_TABLES).map((table) => [table, []]));
}

function descriptor(table, row, classification = 'production-user-content') {
    return {
        key: sourceManifestKey(table, row),
        rowSha256: canonicalHash(row),
        classification
    };
}

async function createFixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ims-fudaba-media-'));
    t.after(() => fs.rmSync(root, { force: true, recursive: true }));
    const snapshotDirectory = path.join(root, 'snapshot');
    const sourceRoot = path.join(root, 'r2-export');
    fs.mkdirSync(snapshotDirectory);
    fs.mkdirSync(path.join(sourceRoot, 'objects'), { recursive: true });
    const front = await sharp({
        create: { width: 8, height: 10, channels: 4, background: '#ff3366' }
    }).png().toBuffer();
    const back = await sharp({
        create: { width: 10, height: 8, channels: 4, background: '#3366ff' }
    }).png().toBuffer();
    fs.writeFileSync(path.join(sourceRoot, 'objects', 'front.png'), front);
    fs.writeFileSync(path.join(sourceRoot, 'objects', 'back.png'), back);

    const createdAt = '2026-07-15T01:02:03.000Z';
    const user = {
        id: 'account-a', display_name: 'Alice', avatar_url: '', home_city: '上海',
        created_at: createdAt, bio: '', updated_at: createdAt
    };
    const oauth = {
        provider: 'google', provider_user_id: 'google-a', user_id: 'account-a',
        provider_username: 'alice', provider_avatar_url: '', created_at: createdAt,
        updated_at: createdAt
    };
    const series = { name: 'SideM' };
    const card = {
        id: 'card-a', owner_id: 'account-a', producer_name: 'Alice',
        display_name: 'Alice card', series: 'SideM', favorite_idol: '冬马',
        front_image: `/media/${FRONT_KEY}`, back_image: `/media/${BACK_KEY}`,
        accent: '#4f64dd', bio: '', trade_note: '', available: 1,
        created_at: createdAt, source_url: null, source_label: null, source_credit: null
    };
    const rows = emptyRows();
    rows.users = [user];
    rows.oauth_accounts = [oauth];
    rows.series_tags = [series];
    rows.cards = [card];
    const tables = {};
    for (const table of Object.keys(SOURCE_TABLES)) {
        if (['sessions', 'oauth_states'].includes(table)) {
            tables[table] = {
                count: 0, migrated: false, redactedFromSnapshot: true
            };
        } else {
            tables[table] = rows[table].map((row) => descriptor(table, row));
        }
    }
    const rowsManifest = {
        schemaVersion: 1,
        snapshotId: SNAPSHOT_ID,
        sourceSha256: SOURCE_SHA256,
        tables
    };
    const sourceJson = {
        schemaVersion: 1,
        snapshotId: SNAPSHOT_ID,
        source: {
            commit: FUDABA_COMMIT,
            d1DatabaseId: FUDABA_D1_DATABASE_ID,
            r2Bucket: FUDABA_R2_BUCKET,
            exportedAt: '2026-07-16T03:04:05.000Z'
        },
        sourceExport: { sha256: SOURCE_SHA256 }
    };
    const snapshot = {
        directory: snapshotDirectory,
        sourceJson,
        rowsManifest,
        rows,
        artifactSha256: {
            source: 'b'.repeat(64),
            rows: 'c'.repeat(64)
        }
    };
    writeJson(path.join(snapshotDirectory, 'media-manifest.json'), {
        schemaVersion: 2,
        snapshotId: SNAPSHOT_ID,
        sourceSha256: SOURCE_SHA256,
        version: 1,
        mediaPlanSha256: null,
        sourceInventorySha256: null,
        entries: []
    });
    writeJson(path.join(snapshotDirectory, 'rights-manifest.json'), {
        schemaVersion: 2,
        snapshotId: SNAPSHOT_ID,
        sourceSha256: SOURCE_SHA256,
        version: 1,
        mediaPlanSha256: null,
        approvals: []
    });
    const entries = [
        {
            key: FRONT_KEY, versionId: null, etag: 'front-etag',
            bytes: front.byteLength, contentType: 'image/png', sha256: digest(front),
            customMetadata: { ownerId: 'account-a', side: 'front' },
            exportPath: 'objects/front.png'
        },
        {
            key: BACK_KEY, versionId: null, etag: 'back-etag',
            bytes: back.byteLength, contentType: 'image/png', sha256: digest(back),
            customMetadata: { ownerId: 'account-a', side: 'back' },
            exportPath: 'objects/back.png'
        }
    ].sort((left, right) => Buffer.compare(Buffer.from(left.key), Buffer.from(right.key)));
    const inventory = path.join(snapshotDirectory, 'source-r2-inventory.json');
    writeJson(inventory, {
        schemaVersion: 1,
        snapshotId: SNAPSHOT_ID,
        sourceSha256: SOURCE_SHA256,
        sourceCommit: FUDABA_COMMIT,
        d1DatabaseId: FUDABA_D1_DATABASE_ID,
        sourceBucket: FUDABA_R2_BUCKET,
        generatedAt: '2026-07-16T03:04:05.000Z',
        complete: true,
        objectCount: entries.length,
        entries
    });
    return { root, snapshot, snapshotDirectory, sourceRoot, inventory };
}

class MemoryTarget {
    constructor() {
        this.objects = new Map();
        this.puts = [];
        this.deletes = [];
        this.nextId = 1;
        this.failOnPut = null;
        this.storage = {
            get: async (key) => {
                const current = this.objects.get(key);
                return current ? {
                    body: current.body,
                    size: current.body.byteLength,
                    contentType: current.contentType,
                    etag: current.etag
                } : null;
            },
            putIfUnchanged: async (key, expected, body, options) => {
                assert.equal(expected, null);
                assert.equal(options.protectedAccess, true);
                assert.equal(options.deferredPublication, undefined);
                if (this.failOnPut === key) throw new Error('injected target failure');
                if (this.objects.has(key)) return null;
                const objectId = `object-${this.nextId++}`;
                const current = {
                    body: Buffer.from(body),
                    byteSize: body.byteLength,
                    contentType: options.contentType,
                    sha256: options.sha256,
                    etag: `etag-${objectId}`,
                    objectId,
                    ownerToken: options.ownerToken,
                    physicalObjectKey: `test/__protected/${key}/objects/${objectId}`,
                    state: 'ready',
                    storageScope: 'private'
                };
                this.objects.set(key, current);
                this.puts.push({ key, options });
                return {
                    body: current.body,
                    size: current.byteSize,
                    contentType: current.contentType,
                    etag: current.etag
                };
            },
            deleteIfOwned: async (key, ownerToken) => {
                const current = this.objects.get(key);
                if (!current || current.ownerToken !== ownerToken) return false;
                this.objects.delete(key);
                this.deletes.push({ key, fence: 'ownerToken' });
                return true;
            },
            deleteIfObjectId: async (key, objectId) => {
                const current = this.objects.get(key);
                if (!current || current.objectId !== objectId) return false;
                this.objects.delete(key);
                this.deletes.push({ key, fence: 'objectId' });
                return true;
            }
        };
    }

    inspectTarget = async (key) => {
        const current = this.objects.get(key);
        return current ? {
            state: current.state,
            objectId: current.objectId,
            physicalObjectKey: current.physicalObjectKey,
            storageScope: current.storageScope,
            byteSize: current.byteSize,
            contentType: current.contentType,
            sha256: current.sha256,
            etag: current.etag,
            ownerToken: current.ownerToken
        } : null;
    };

    runtime() {
        return { storage: this.storage, inspectTarget: this.inspectTarget };
    }
}

function migrationOptions(fixture, apply = false) {
    return {
        snapshotDirectory: fixture.snapshotDirectory,
        sourceRoot: fixture.sourceRoot,
        inventory: fixture.inventory,
        targetBucket: 'imsweb-media-test',
        apply
    };
}

function approveRights(fixture) {
    const filename = path.join(fixture.snapshotDirectory, 'rights-manifest.json');
    const rights = JSON.parse(fs.readFileSync(filename, 'utf8'));
    for (const approval of rights.approvals) {
        approval.status = 'approved';
        approval.action = 'store-protected';
        approval.reviewedBy = 'migration-reviewer';
        approval.reviewedAt = '2026-07-17T00:00:00.000Z';
        approval.evidenceSha256 = digest(`evidence:${approval.bindingSha256}`);
    }
    writeJson(filename, rights);
}

function applyConfirmations(report) {
    return {
        confirmSnapshotId: report.snapshotId,
        confirmSourceSha256: report.sourceSha256,
        confirmSourceManifestSha256: report.artifactSha256.sourceManifestSha256,
        confirmRowsSha256: report.artifactSha256.rowsSha256,
        confirmInventorySha256: report.artifactSha256.inventorySha256,
        confirmPlanSha256: report.artifactSha256.planSha256,
        confirmRightsSha256: report.artifactSha256.rightsSha256,
        confirmMediaSha256: report.artifactSha256.mediaSha256,
        confirmSourceBucket: report.sourceBucket,
        confirmTargetBucket: report.targetBucket
    };
}

test('Fudaba media CLI is dry-run by default and requires explicit paths', () => {
    assert.equal(parseArguments([
        '--snapshot', '/tmp/snapshot', '--source-root', '/tmp/export'
    ]).apply, false);
    assert.throws(() => parseArguments(['--apply']), /Usage:/);
    assert.throws(() => parseArguments(['--wat']), /Unknown option/);
    assert.equal(parseArguments(['--help']).help, true);
});

test('Fudaba R2 locators reject encoded, traversing, or ambiguous paths', () => {
    assert.equal(r2KeyFromLocator(`/media/${FRONT_KEY}`), FRONT_KEY);
    for (const locator of [
        '/media/cards/a/%2e%2e/x.png',
        '/media/cards/a/%252e%252e/x.png',
        '/media/cards/a/front.png?version=1',
        '/media/cards/a/front.png#hash',
        '/media/cards\\a\\front.png',
        '/media/cards/a//front.png',
        '/media/cards/a/%zz.png'
    ]) assert.throws(() => r2KeyFromLocator(locator), /Fudaba|safe normalized/);
});

test('dry-run scaffolds v2 rights and performs no target writes', async (t) => {
    const fixture = await createFixture(t);
    let targetResolutions = 0;
    const report = await runFudabaMediaMigration(migrationOptions(fixture), {
        snapshot: fixture.snapshot,
        targetBucket: 'imsweb-media-test',
        async resolveTarget() {
            targetResolutions += 1;
            throw new Error('target must not be opened while rights are unknown');
        }
    });
    assert.equal(report.status, 'blocked');
    assert.equal(report.summary.blockers, 2);
    assert.equal(targetResolutions, 0);
    const rightsFile = path.join(fixture.snapshotDirectory, 'rights-manifest.json');
    const mediaFile = path.join(fixture.snapshotDirectory, 'media-manifest.json');
    assert.equal(fs.statSync(rightsFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(mediaFile).mode & 0o777, 0o600);
    assert.deepEqual(
        JSON.parse(fs.readFileSync(rightsFile, 'utf8')).approvals.map((entry) => entry.status),
        ['unknown', 'unknown']
    );
});

test('approved apply writes private-ready objects, reads back, and converges', async (t) => {
    const fixture = await createFixture(t);
    await runFudabaMediaMigration(migrationOptions(fixture), {
        snapshot: fixture.snapshot,
        targetBucket: 'imsweb-media-test'
    });
    approveRights(fixture);
    const target = new MemoryTarget();
    const dryRun = await runFudabaMediaMigration(migrationOptions(fixture), {
        snapshot: fixture.snapshot,
        targetBucket: 'imsweb-media-test',
        targetRuntime: target.runtime()
    });
    assert.equal(dryRun.status, 'ready');
    assert.equal(dryRun.summary.missing, 2);
    assert.equal(target.puts.length, 0);

    const applied = await runFudabaMediaMigration({
        ...migrationOptions(fixture, true),
        ...applyConfirmations(dryRun)
    }, {
        snapshot: fixture.snapshot,
        targetBucket: 'imsweb-media-test',
        targetRuntime: target.runtime()
    });
    assert.equal(applied.status, 'passed');
    assert.equal(applied.summary.uploaded, 2);
    assert.equal(target.puts.length, 2);
    assert.ok(target.puts.every((entry) => entry.options.protectedAccess === true));
    const media = JSON.parse(fs.readFileSync(
        path.join(fixture.snapshotDirectory, 'media-manifest.json'), 'utf8'
    ));
    assert.ok(media.entries.every((entry) =>
        entry.state === 'ready' && entry.storageScope === 'private' &&
        entry.sha256 === entry.readbackSha256 && entry.objectId
    ));

    const repeated = await runFudabaMediaMigration({
        ...migrationOptions(fixture, true),
        ...applyConfirmations(applied)
    }, {
        snapshot: fixture.snapshot,
        targetBucket: 'imsweb-media-test',
        targetRuntime: target.runtime()
    });
    assert.equal(repeated.status, 'passed');
    assert.equal(repeated.summary.unchanged, 2);
    assert.equal(repeated.summary.uploaded, 0);
    assert.equal(target.puts.length, 2);
});

test('apply confirmations fail before the target runtime is resolved', async (t) => {
    const fixture = await createFixture(t);
    await runFudabaMediaMigration(migrationOptions(fixture), {
        snapshot: fixture.snapshot,
        targetBucket: 'imsweb-media-test'
    });
    approveRights(fixture);
    let resolutions = 0;
    await assert.rejects(
        runFudabaMediaMigration(migrationOptions(fixture, true), {
            snapshot: fixture.snapshot,
            targetBucket: 'imsweb-media-test',
            async resolveTarget() {
                resolutions += 1;
                return new MemoryTarget().runtime();
            }
        }),
        (error) => error instanceof FudabaMediaBlockedError &&
            /confirm-snapshot-id/.test(error.message)
    );
    assert.equal(resolutions, 0);
});

test('a public or different existing target is a non-overwriting conflict', async (t) => {
    const fixture = await createFixture(t);
    await runFudabaMediaMigration(migrationOptions(fixture), {
        snapshot: fixture.snapshot,
        targetBucket: 'imsweb-media-test'
    });
    approveRights(fixture);
    const target = new MemoryTarget();
    const key = 'community/fudaba/cards/card-a/front.png';
    target.objects.set(key, {
        body: Buffer.from('different'),
        byteSize: 9,
        contentType: 'image/png',
        sha256: digest('different'),
        etag: 'existing',
        objectId: 'existing-object',
        ownerToken: null,
        physicalObjectKey: `public/${key}`,
        state: 'ready',
        storageScope: 'public'
    });
    const report = await runFudabaMediaMigration(migrationOptions(fixture), {
        snapshot: fixture.snapshot,
        targetBucket: 'imsweb-media-test',
        targetRuntime: target.runtime()
    });
    assert.equal(report.status, 'blocked');
    assert.equal(report.summary.conflicts, 1);
    assert.equal(target.puts.length, 0);
    assert.equal(target.objects.get(key).objectId, 'existing-object');
});

test('batch failure compensates only objects created by the migration', async () => {
    const target = new MemoryTarget();
    const entries = ['one', 'two'].map((id) => {
        const body = Buffer.from(`body-${id}`);
        return {
            entityKind: 'card', entityId: id, slot: 'front',
            logicalObjectKey: `community/fudaba/cards/${id}/front.png`,
            sourceObject: {
                key: `cards/a/${id}-front.png`,
                etag: `etag-${id}`,
                bytes: body.byteLength,
                contentType: 'image/png',
                sha256: digest(body)
            },
            sourceBody: body,
            bindingSha256: digest(`binding-${id}`),
            sourceReference: `/media/cards/a/${id}-front.png`
        };
    });
    target.failOnPut = entries[1].logicalObjectKey;
    await assert.rejects(
        applyMissingTransfers(
            entries, target.runtime(), 'fudaba-media:test', 'imsweb-media-test'
        ),
        (error) => {
            assert.equal(error.message, 'injected target failure');
            assert.ok(error.compensation.some((entry) => entry.fence === 'objectId'));
            return true;
        }
    );
    assert.equal(target.objects.size, 0);
    assert.ok(target.deletes.every((entry) =>
        ['objectId', 'ownerToken'].includes(entry.fence)
    ));
});

test('a CAS loser cannot compensate an object created by a competing invocation', async () => {
    const target = new MemoryTarget();
    const body = Buffer.from('competing-body');
    const entry = {
        entityKind: 'card', entityId: 'race', slot: 'front',
        logicalObjectKey: 'community/fudaba/cards/race/front.png',
        sourceObject: {
            key: 'cards/account-a/33333333-3333-4333-8333-333333333333-front.png',
            etag: 'source-race',
            bytes: body.byteLength,
            contentType: 'image/png',
            sha256: digest(body)
        },
        sourceBody: body,
        bindingSha256: digest('binding-race'),
        sourceReference: '/media/cards/account-a/' +
            '33333333-3333-4333-8333-333333333333-front.png'
    };
    const competingOwner = 'fudaba-media:snapshot:invocation-b';
    target.storage.putIfUnchanged = async (key) => {
        target.objects.set(key, {
            body,
            byteSize: body.byteLength,
            contentType: 'image/png',
            sha256: digest(body),
            etag: 'competing-etag',
            objectId: 'competing-object',
            ownerToken: competingOwner,
            physicalObjectKey: `test/__protected/${key}/objects/competing-object`,
            state: 'ready',
            storageScope: 'private'
        });
        return null;
    };
    await assert.rejects(
        applyMissingTransfers(
            [entry],
            target.runtime(),
            'fudaba-media:snapshot:invocation-a',
            'imsweb-media-test',
            'snapshot'
        ),
        /Concurrent target mutation/
    );
    assert.equal(target.objects.get(entry.logicalObjectKey).ownerToken, competingOwner);
    assert.equal(target.objects.get(entry.logicalObjectKey).objectId, 'competing-object');
    assert.deepEqual(target.deletes, []);
});

test('media apply refuses storage adapters without CAS and fenced deletion', async () => {
    await assert.rejects(
        applyMissingTransfers(
            [],
            { storage: {} },
            'fudaba-media:snapshot:invocation',
            'imsweb-media-test',
            'snapshot'
        ),
        /requires CAS and fenced object-storage mutations/
    );
});

test('inventory bytes and rights bindings are immutable migration inputs', async (t) => {
    const fixture = await createFixture(t);
    const first = await runFudabaMediaMigration(migrationOptions(fixture), {
        snapshot: fixture.snapshot,
        targetBucket: 'imsweb-media-test'
    });
    const rightsFile = path.join(fixture.snapshotDirectory, 'rights-manifest.json');
    const rights = JSON.parse(fs.readFileSync(rightsFile, 'utf8'));
    rights.approvals[0].bindingSha256 = 'f'.repeat(64);
    writeJson(rightsFile, rights);
    await assert.rejects(
        runFudabaMediaMigration(migrationOptions(fixture), {
            snapshot: fixture.snapshot,
            targetBucket: 'imsweb-media-test'
        }),
        /Rights approval does not match/
    );
    assert.ok(SHA256_PATTERN_OR_THROW(first.artifactSha256.inventorySha256));
});

function SHA256_PATTERN_OR_THROW(value) {
    assert.match(value, /^[a-f0-9]{64}$/);
    return true;
}
