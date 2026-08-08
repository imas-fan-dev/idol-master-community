const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const ADD_USER_SCRIPT = path.join(
    PROJECT_ROOT,
    'scripts/operations/accounts/add-user.js'
);
const HASH_PASSWORD_SCRIPT = path.join(
    PROJECT_ROOT,
    'scripts/operations/accounts/hash-password.js'
);
const CONTAINER_DATA_SCRIPT = path.join(
    PROJECT_ROOT,
    'scripts/development/container-data.js'
);
const { addUser, databaseUrl } = require(ADD_USER_SCRIPT);
const {
    ARCHIVE_ROOT,
    isNonEmptyFile,
    parseArguments,
    validateArchiveEntries,
    validateArchiveEntryTypes,
    validateManifest
} = require(CONTAINER_DATA_SCRIPT);
const {
    compareInventories,
    parseArguments: parseRustfsSyncArguments,
    resolveTargetEnvironment,
    summarizeInventory,
    validateSourceEnvironment
} = require('../scripts/development/sync-r2-to-rustfs.js');

test('categorized add-user script writes a PostgreSQL backoffice account', async () => {
    const calls = [];
    let poolConfiguration;
    let poolEnded = false;

    class FakePool {
        constructor(configuration) {
            poolConfiguration = configuration;
        }

        async query(sql, parameters) {
            calls.push({ sql, parameters });
            return { rowCount: 1, rows: [{ id: 42 }] };
        }

        async end() {
            poolEnded = true;
        }
    }

    const messages = [];
    const environment = {
        DATABASE_URL: 'postgresql://imsweb:secret@127.0.0.1:5432/imsweb',
        IMS_NEW_USER_USERNAME: 'categorized-script-test',
        IMS_NEW_USER_PASSWORD: 'temporary-test-password',
        IMS_NEW_USER_DEPT: 'op',
        IMS_NEW_USER_PRODUCER_NAME: 'Script Test'
    };
    const result = await addUser({
        environment,
        PoolClass: FakePool,
        hashPassword: async (password, rounds) => {
            assert.equal(password, 'temporary-test-password');
            assert.equal(rounds, 12);
            return 'test-password-hash';
        },
        logger: {
            error: message => messages.push(`error:${message}`),
            log: message => messages.push(`log:${message}`)
        }
    });

    assert.deepEqual(poolConfiguration, {
        connectionString: environment.DATABASE_URL,
        application_name: 'imsweb-ops-add-user'
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /INSERT INTO backoffice_accounts/);
    assert.doesNotMatch(calls[0].sql, /INSERT INTO users/);
    assert.deepEqual(calls[0].parameters, [
        'categorized-script-test',
        'test-password-hash',
        'op',
        'Script Test',
        'admin'
    ]);
    assert.deepEqual(result, { created: true, id: 42 });
    assert.deepEqual(messages, ['log:User created with ID 42.']);
    assert.equal(poolEnded, true);
});

test('categorized add-user script requires a PostgreSQL DATABASE_URL', () => {
    assert.throws(
        () => databaseUrl({}),
        /DATABASE_URL is required for PostgreSQL/
    );
    assert.throws(
        () => databaseUrl({ DATABASE_URL: 'sqlite:accounts.db' }),
        /DATABASE_URL must be a valid PostgreSQL URL/
    );
});

test('categorized password helper emits a bcrypt hash without database access', () => {
    const result = spawnSync(process.execPath, [HASH_PASSWORD_SCRIPT], {
        cwd: os.tmpdir(),
        env: { ...process.env, IMS_PASSWORD_TO_HASH: 'temporary-test-password' },
        encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout.trim(), /^\$2[aby]\$/);
});

test('development data script parses export and guarded restore commands', () => {
    assert.deepEqual(
        parseArguments(['export', '--', '--output', 'data/exports/test.tgz']),
        {
            action: 'export',
            output: 'data/exports/test.tgz',
            archive: undefined,
            force: false
        }
    );
    assert.deepEqual(
        parseArguments(['restore', 'data/exports/test.tgz', '--force']),
        {
            action: 'restore',
            output: undefined,
            archive: 'data/exports/test.tgz',
            force: true
        }
    );
    assert.throws(
        () => parseArguments(['restore']),
        /requires an archive path/
    );
});

test('development data script rejects archive traversal and invalid manifests', () => {
    assert.doesNotThrow(() => validateArchiveEntries([
        `${ARCHIVE_ROOT}/`,
        `${ARCHIVE_ROOT}/manifest.json`,
        `${ARCHIVE_ROOT}/postgresql.dump`,
        `${ARCHIVE_ROOT}/rustfs/imsweb-media-local/object.jpg`
    ]));
    assert.throws(
        () => validateArchiveEntries([
            `${ARCHIVE_ROOT}/manifest.json`,
            `${ARCHIVE_ROOT}/../outside`
        ]),
        /Unsafe or unexpected archive entry/
    );
    assert.throws(
        () => validateManifest({ formatVersion: 999 }),
        /Unsupported snapshot format version/
    );
    assert.throws(
        () => validateArchiveEntryTypes([
            'lrwxr-xr-x  0 user group 0 Jan 1 00:00 snapshot-link'
        ]),
        /only files and directories/
    );
    assert.throws(
        () => validateManifest({
            formatVersion: 2,
            archiveRoot: ARCHIVE_ROOT,
            postgresql: {
                file: 'postgresql.dump',
                publicTables: 1,
                bytes: 1
            },
            rustfs: {
                bucket: 'imsweb-media-local',
                directory: '../outside',
                objects: 0,
                bytes: 0
            }
        }),
        /manifest is incomplete or invalid/
    );
    assert.doesNotThrow(() => validateManifest({
        formatVersion: 1,
        archiveRoot: ARCHIVE_ROOT,
        postgresql: {
            file: 'postgresql.dump',
            publicTables: 1,
            bytes: 1
        },
        minio: {
            bucket: 'imsweb-media-local',
            directory: 'minio/imsweb-media-local',
            objects: 0,
            bytes: 0
        }
    }));
});

test('development data script recognizes only non-empty regular files', () => {
    const temporaryDirectory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'ims-container-data-test-')
    );
    const emptyPath = path.join(temporaryDirectory, 'empty.tgz');
    const snapshotPath = path.join(temporaryDirectory, 'snapshot.tgz');
    try {
        fs.writeFileSync(emptyPath, '');
        fs.writeFileSync(snapshotPath, 'snapshot');
        assert.equal(isNonEmptyFile(temporaryDirectory), false);
        assert.equal(isNonEmptyFile(emptyPath), false);
        assert.equal(isNonEmptyFile(snapshotPath), true);
        assert.equal(isNonEmptyFile(path.join(temporaryDirectory, 'missing')), false);
    } finally {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
});

test('RustFS sync validates isolated R2 source and local target settings', () => {
    const source = validateSourceEnvironment({
        IMS_OBJECT_STORAGE: 's3',
        IMS_S3_BUCKET: 'imsweb-media-public-test',
        IMS_S3_REGION: 'auto',
        IMS_S3_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
        IMS_S3_FORCE_PATH_STYLE: 'false',
        AWS_ACCESS_KEY_ID: 'access-key',
        AWS_SECRET_ACCESS_KEY: 'secret-key'
    });
    assert.equal(source.bucket, 'imsweb-media-public-test');
    assert.equal(source.region, 'auto');
    assert.throws(
        () => validateSourceEnvironment({
            IMS_OBJECT_STORAGE: 's3',
            IMS_S3_BUCKET: 'imsweb-media-prod',
            IMS_S3_REGION: 'auto',
            IMS_S3_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
            IMS_S3_FORCE_PATH_STYLE: 'false',
            AWS_ACCESS_KEY_ID: 'access-key',
            AWS_SECRET_ACCESS_KEY: 'secret-key'
        }),
        /distinct test segment/
    );
    assert.deepEqual(resolveTargetEnvironment({}), {
        bucket: 'imsweb-media-local',
        endpoint: 'http://127.0.0.1:9000',
        region: 'us-east-1',
        accessKeyId: 'imsweb-local',
        secretAccessKey: 'imsweb-local-password'
    });
});

test('RustFS sync reports exact inventory differences and parses apply mode', () => {
    const source = new Map([
        ['objects/a', 12],
        ['objects/b', 20]
    ]);
    const target = new Map([
        ['objects/a', 11],
        ['objects/c', 30]
    ]);
    assert.deepEqual(compareInventories(source, target), {
        missing: ['objects/b'],
        mismatched: ['objects/a'],
        extra: ['objects/c']
    });
    assert.deepEqual(summarizeInventory(source), { objects: 2, bytes: 32 });
    const options = parseRustfsSyncArguments(['--apply']);
    assert.equal(options.apply, true);
    assert.equal(options.help, false);
});
