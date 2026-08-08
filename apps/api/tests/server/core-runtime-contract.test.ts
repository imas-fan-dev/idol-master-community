import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createHonoApp } from '@/app';
import { FilesystemCompensationService } from '@/infra/oss/filesystem/compensation-service';
import { FilesystemIdempotencyStore } from '@/infra/cache/filesystem/idempotency-store';
import { FilesystemObjectStorage } from '@/infra/oss/filesystem/object-storage';
import { MemoryRateLimiter } from '@/infra/cache/memory/rate-limiter';
import { PostgresqlSchemaStrategy } from '@/infra/db/postgresql/schema-strategy';
import { SqlCoreRepository } from '@/infra/db/repositories/core-repository';
import { executeSql, queryAll, queryOne } from '@/infra/db/sql/query';
import { HmacBackofficeTokenService } from '@/infra/security/hmac/token-service';
import type { CompensationService } from '@/ports/object-storage';
import type {
    AuditRepository,
    BackofficeAuthRepository,
    EventRepository,
    NamecardRepository,
    NewsRepository,
    ReactionRepository
} from '@/ports/repositories';
import type { ImageProcessor } from '@/ports/media';
import type { ObjectStorage } from '@/ports/object-storage';
import type { ParsedUpload, UploadParser } from '@/ports/http';
import type { RuntimeServices } from '@/ports/runtime-services';
import {
    assertChronicleRateContract,
    assertConcurrentRateLimiterContract,
    assertCoreMutationContract,
    assertPostCommitMediaContract,
    assertRouteUploadBoundaryContract,
    type ControlledUpload
} from '../contracts/runtime-contracts.js';
import { createPostgresTestDatabase } from './postgres-test-database';

const SECRET = 'node-contract-secret-at-least-32-bytes';
const USERNAME = 'node-contract-op';
const PASSWORD = 'contract-password';
const PRODUCER = 'Node Contract Producer';
const APPROVED_CARD_ID = 700;

class ControlledUploadParser implements UploadParser {
    next?: ParsedUpload;
    calls = 0;

    set(value: ControlledUpload): void {
        this.next = value;
    }

    async parse(): Promise<ParsedUpload> {
        this.calls += 1;
        if (!this.next) throw new Error('Controlled upload was not configured');
        const value = this.next;
        this.next = undefined;
        return value;
    }
}

const images: ImageProcessor = {
    async validate() {
        return { format: 'png', width: 1, height: 1, contentType: 'image/png' };
    },
    async toWebp(body) {
        return Uint8Array.of(0x52, 0x49, 0x46, 0x46, body[0] || 0);
    },
    async thumbnailPng(body) {
        return Uint8Array.of(0x89, 0x50, 0x4e, 0x47, body[0] || 0);
    },
    async resizeJpeg(body) {
        return Uint8Array.of(0xff, 0xd8, 0xff, body[0] || 0);
    }
};

interface NodeFixture {
    request(pathname: string, init?: RequestInit): Promise<Response>;
    setUpload(upload: ControlledUpload): void;
    snapshot(): Promise<{
        news: number;
        events: number;
        cards: number;
        reactions: number;
        auditActions: string[];
        objects: number;
        compensation: { pending: number; completed: number };
    }>;
    uploadSnapshot(): Promise<{
        news: number;
        events: number;
        cards: number;
        chronicle: number;
        objects: number;
    }>;
    opToken(): Promise<string>;
    failObjectDeletes(value: boolean): void;
    failBusinessInserts(value: boolean): void;
    failObjectPuts(value: boolean): void;
    failObjectPublishes(value: boolean): void;
    failCompensationEnqueues(value: boolean): void;
    postCommitSnapshot(): Promise<{
        news: number;
        events: number;
        cards: number;
        objects: number;
        compensationPending: number;
    }>;
    mediaDeletionTargets(): Promise<{ news: number; event: number; card: number }>;
    runCompensation(): Promise<void>;
    uploadChronicle(key: string, client: string, activityId: string, body?: BodyInit): Promise<Response>;
    rateSnapshot(client: string): Promise<{
        count: number;
        writeCount: number;
        attemptCount: number;
        records: number;
        objects: number;
        parserCalls: number;
        storageMutations: number;
    }>;
}

async function countFiles(directory: string): Promise<number> {
    let entries: import('node:fs').Dirent[];
    try {
        entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
        throw error;
    }
    let count = 0;
    for (const entry of entries) {
        if (entry.isDirectory()) count += await countFiles(path.join(directory, entry.name));
        else if (entry.isFile()) count += 1;
    }
    return count;
}

async function chronicleRecordCount(metaDirectory: string): Promise<number> {
    let names: string[];
    try {
        names = (await fs.readdir(metaDirectory)).filter((name) => name.endsWith('.json'));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
        throw error;
    }
    let count = 0;
    for (const name of names) {
        const value = JSON.parse(await fs.readFile(path.join(metaDirectory, name), 'utf8')) as
            { records?: unknown[] } | unknown[];
        count += Array.isArray(value) ? value.length : Array.isArray(value.records) ? value.records.length : 0;
    }
    return count;
}

function clientAddress(client: string): string {
    return client === 'replay-client' ? '203.0.113.201'
        : client === 'distinct-client' ? '203.0.113.202'
            : '203.0.113.100';
}

async function createFixture(t: TestContext): Promise<NodeFixture> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ims-node-contract-'));
    const publicDir = path.join(root, 'public');
    const uploadsDir = path.join(root, 'uploads');
    const chronicleDir = path.join(root, 'chronicle');
    const storyDataDir = path.join(root, 'story-data');
    const compensationDir = path.join(root, 'compensation');
    const idempotencyDir = path.join(root, 'idempotency');
    await Promise.all([publicDir, uploadsDir, chronicleDir, storyDataDir].map((directory) =>
        fs.mkdir(directory, { recursive: true })));

    const connection = await createPostgresTestDatabase(t, 'core-runtime');
    const core = new SqlCoreRepository(connection, new PostgresqlSchemaStrategy());
    await core.initialize();
    await executeSql(connection,
        `INSERT INTO users (username, password, dept, producername, admin_role)
         VALUES (?, 'contract-digest', 'op', ?, 'admin')`,
        [USERNAME, PRODUCER]
    );
    await executeSql(connection,
        `INSERT INTO cards (id, image1_url, image2_url, status)
         VALUES (?, '/uploads/namecard/original/contract-seed-front.webp',
                    '/uploads/namecard/original/contract-seed-back.webp', 'approved')`,
        [APPROVED_CARD_ID]
    );

    const parser = new ControlledUploadParser();
    const limiter = new MemoryRateLimiter();
    const delegate = new FilesystemObjectStorage({ publicDir, uploadsDir, chronicleDir, storyDataDir });
    const compensationDelegate = new FilesystemCompensationService(compensationDir);
    let businessInsertFailure = false;
    let deleteFailure = false;
    let putFailure = false;
    let publishFailure = false;
    let compensationEnqueueFailure = false;
    let storageMutations = 0;
    const repository = new Proxy(core, {
        get(target, property, receiver) {
            if (property === 'insertNews') {
                return async (...args: Parameters<NewsRepository['insertNews']>) => {
                    if (businessInsertFailure) throw new Error('injected news insert failure');
                    return target.insertNews(...args);
                };
            }
            if (property === 'insertEvent') {
                return async (...args: Parameters<EventRepository['insertEvent']>) => {
                    if (businessInsertFailure) throw new Error('injected event insert failure');
                    return target.insertEvent(...args);
                };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
        }
    }) as BackofficeAuthRepository & AuditRepository & NewsRepository & EventRepository &
        NamecardRepository & ReactionRepository;
    const compensation = new Proxy(compensationDelegate, {
        get(target, property, receiver) {
            if (property === 'enqueue') {
                return async (...args: Parameters<CompensationService['enqueue']>) => {
                    if (compensationEnqueueFailure) {
                        throw new Error('injected compensation enqueue failure');
                    }
                    return target.enqueue(...args);
                };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
        }
    }) as CompensationService;
    const storage = new Proxy(delegate, {
        get(target, property, receiver) {
            if (property === 'delete') {
                return async (key: string) => {
                    if (deleteFailure) throw new Error('injected object delete failure');
                    storageMutations += 1;
                    return target.delete(key);
                };
            }
            if (property === 'put') {
                return async (...args: Parameters<ObjectStorage['put']>) => {
                    if (putFailure) throw new Error('injected object put failure');
                    storageMutations += 1;
                    return target.put(...args);
                };
            }
            if (property === 'putIfUnchanged') {
                return async (...args: Parameters<NonNullable<ObjectStorage['putIfUnchanged']>>) => {
                    storageMutations += 1;
                    return target.putIfUnchanged(...args);
                };
            }
            if (property === 'publish') {
                return async (key: string) => {
                    if (publishFailure) throw new Error('injected object publish failure');
                    const publish = (target as ObjectStorage).publish;
                    await publish?.call(target, key);
                };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
        }
    }) as ObjectStorage;
    const runtime: RuntimeServices = {
        backofficeAuth: repository,
        audit: repository,
        news: repository,
        events: repository,
        namecards: repository,
        reactions: repository,
        compensation,
        storage,
        images,
        idempotency: new FilesystemIdempotencyStore(idempotencyDir),
        passwords: { async verify(value, digest) { return value === PASSWORD && digest === 'contract-digest'; } },
        backofficeTokens: new HmacBackofficeTokenService(SECRET),
        rateLimiter: limiter,
        uploads: parser,
        config: { cookieSecure: false, clientAddressSource: 'nginx' }
    };
    const app = createHonoApp(() => runtime);
    t.after(async () => {
        await core.close();
        await fs.rm(root, { recursive: true, force: true });
    });

    const request = (pathname: string, init: RequestInit = {}): Promise<Response> => {
        const headers = new Headers(init.headers);
        if (!headers.has('x-forwarded-for')) headers.set('X-Forwarded-For', clientAddress('default'));
        return Promise.resolve(app.request(`http://ims.test${pathname}`, { ...init, headers }));
    };

    const objectCount = () => Promise.all([
        countFiles(uploadsDir),
        countFiles(path.join(chronicleDir, 'media/pending')),
        countFiles(path.join(chronicleDir, 'media/published')),
        countFiles(path.join(chronicleDir, 'trash'))
    ]).then((counts) => counts.reduce((sum, count) => sum + count, 0));

    const compensationCounts = async (): Promise<{ pending: number; completed: number }> => {
        let names: string[];
        try {
            names = (await fs.readdir(compensationDir)).filter((name) => name.endsWith('.json'));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { pending: 0, completed: 0 };
            throw error;
        }
        const states = await Promise.all(names.map(async (name) =>
            (JSON.parse(await fs.readFile(path.join(compensationDir, name), 'utf8')) as { state: string }).state));
        return {
            pending: states.filter((state) => state === 'pending' || state === 'failed' || state === 'running').length,
            completed: states.filter((state) => state === 'completed').length
        };
    };

    const uploadSnapshot = async () => ({
        news: (await queryOne<{ count: number }>(connection, 'SELECT COUNT(*) AS count FROM news'))!.count,
        events: (await queryOne<{ count: number }>(connection, 'SELECT COUNT(*) AS count FROM events'))!.count,
        cards: (await queryOne<{ count: number }>(connection, 'SELECT COUNT(*) AS count FROM cards'))!.count,
        chronicle: await chronicleRecordCount(path.join(chronicleDir, 'metadata')),
        objects: await objectCount()
    });

    const postCommitSnapshot = async () => {
        const upload = await uploadSnapshot();
        return {
            news: upload.news,
            events: upload.events,
            cards: upload.cards,
            objects: upload.objects,
            compensationPending: (await compensationCounts()).pending
        };
    };

    const mediaDeletionTargets = async () => ({
        news: (await queryOne<{ id: number }>(connection,
            "SELECT id FROM news WHERE image<>'' ORDER BY id DESC LIMIT 1"
        ))?.id || 0,
        event: (await queryOne<{ id: number }>(connection,
            "SELECT id FROM events WHERE image_url<>'' ORDER BY id DESC LIMIT 1"
        ))?.id || 0,
        card: (await queryOne<{ id: number }>(connection,
            'SELECT id FROM cards ORDER BY id DESC LIMIT 1'
        ))?.id || 0
    });

    const opToken = async (): Promise<string> => {
        const response = await request('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: USERNAME, password: PASSWORD })
        });
        assert.equal(response.status, 200);
        return (await response.json() as { token: string }).token;
    };

    return {
        request,
        setUpload: (upload) => parser.set(upload),
        async snapshot() {
            const upload = await uploadSnapshot();
            const audit = await queryAll<{ action: string }>(connection, 'SELECT action FROM logs ORDER BY id');
            return {
                news: upload.news,
                events: upload.events,
                cards: upload.cards,
                reactions: (await queryOne<{ count: number }>(connection,
                    'SELECT COALESCE(SUM(count), 0) AS count FROM card_emojis'
                ))!.count,
                auditActions: audit.map((row) => row.action),
                objects: upload.objects,
                compensation: await compensationCounts()
            };
        },
        uploadSnapshot,
        opToken,
        failObjectDeletes(value) { deleteFailure = value; },
        failBusinessInserts(value) { businessInsertFailure = value; },
        failObjectPuts(value) { putFailure = value; },
        failObjectPublishes(value) { publishFailure = value; },
        failCompensationEnqueues(value) { compensationEnqueueFailure = value; },
        postCommitSnapshot,
        mediaDeletionTargets,
        runCompensation: () => compensation.run(storage, 100),
        async uploadChronicle(key, client, activityId, body: BodyInit = '--contract--') {
            parser.set({
                fields: { activityId, username: 'Rate Contract' },
                files: { images: [{ filename: 'rate.png', contentType: 'image/png', body: Uint8Array.of(1) }] }
            });
            const init: RequestInit & { duplex?: 'half' } = {
                method: 'POST',
                headers: {
                    'Content-Type': 'multipart/form-data; boundary=contract',
                    'Idempotency-Key': key,
                    'X-Forwarded-For': clientAddress(client)
                },
                body
            };
            if (body instanceof ReadableStream) init.duplex = 'half';
            return request('/eventchronicle/upload', init);
        },
        async rateSnapshot(client) {
            const windows = (limiter as unknown as {
                windows: Map<string, { identities: Set<string> }>;
            }).windows;
            return {
                count: windows.get(`public-upload\0${clientAddress(client)}`)?.identities.size || 0,
                writeCount: windows.get(
                    `chronicle-upload-write\0${clientAddress(client)}`
                )?.identities.size || 0,
                attemptCount: windows.get(
                    `chronicle-upload-attempt\0${clientAddress(client)}`
                )?.identities.size || 0,
                records: await chronicleRecordCount(path.join(chronicleDir, 'metadata')),
                objects: await objectCount(),
                parserCalls: parser.calls,
                storageMutations
            };
        }
    };
}

test('[CORE-01] shared mutation contract uses Node PostgreSQL/filesystem adapters', async (t) => {
    const fixture = await createFixture(t);
    await assertCoreMutationContract({
        runtime: 'Node',
        username: USERNAME,
        password: PASSWORD,
        producername: PRODUCER,
        approvedCardId: APPROVED_CARD_ID,
        ...fixture
    });
});

test('[STATE-01] post-commit media failures preserve Node success semantics', async (t) => {
    const fixture = await createFixture(t);
    await assertPostCommitMediaContract({ runtime: 'Node', ...fixture });
});

test('[STATE-01] namecard approval retries object publication before success', async (t) => {
    const fixture = await createFixture(t);
    const token = await fixture.opToken();
    const approve = () => fixture.request(`/api/admin/cards/approve/${APPROVED_CARD_ID}`, {
        method: 'POST',
        headers: { Authorization: token }
    });

    fixture.failObjectPublishes(true);
    const failed = await approve();
    assert.equal(failed.status, 200);
    assert.deepEqual(await failed.json(), { success: false });

    fixture.failObjectPublishes(false);
    const retried = await approve();
    assert.equal(retried.status, 200);
    assert.deepEqual(await retried.json(), { success: true });
    assert.equal((await fixture.snapshot()).auditActions.filter(
        (action) => action === '审核图片通过'
    ).length, 1);
});

test('[MEDIA-01] shared route boundaries use Node PostgreSQL/filesystem adapters', async (t) => {
    const fixture = await createFixture(t);
    await assertRouteUploadBoundaryContract({ runtime: 'Node', ...fixture });
});

test('[STATE-01] shared Chronicle upload budgets run before parsing with the Node limiter', async (t) => {
    const fixture = await createFixture(t);
    await assertChronicleRateContract({ runtime: 'Node', ...fixture });
});

test('[STATE-01] concurrent rate identities remain atomic in memory', async () => {
    const limiter = new MemoryRateLimiter();
    const windows = (limiter as unknown as {
        windows: Map<string, { identities: Set<string> }>;
    }).windows;
    await assertConcurrentRateLimiterContract({
        runtime: 'Node',
        consume: (client, identity) => limiter.consume(
            'concurrent-contract', client, 30, 60 * 60,
            { operation: 'chronicle:upload', identity }
        ),
        async count(client) {
            return windows.get(`concurrent-contract\0${client}`)?.identities.size || 0;
        }
    });
});
