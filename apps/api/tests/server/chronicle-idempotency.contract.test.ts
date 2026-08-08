import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHonoApp } from '@/app';
import { HmacBackofficeTokenService } from '@/infra/security/hmac/token-service';
import type { IdempotencyClaim, IdempotencyResponse, IdempotencyStore } from '@/ports/cache';
import {
    CHRONICLE_UPLOAD_ATTEMPT_LIMIT,
    CHRONICLE_UPLOAD_WRITE_LIMIT
} from '@/middleware/rate-limit';
import type { ImageInfo, ImageProcessor } from '@/ports/media';
import type { CompensationService } from '@/ports/object-storage';
import type { ObjectStorage, PutObjectOptions, StoredObject } from '@/ports/object-storage';
import type { RateLimiter, RateLimitIdentity, RateLimitResult } from '@/ports/cache';
import type { RuntimeServices } from '@/ports/runtime-services';
import type { ParsedUpload, UploadParser } from '@/ports/http';

const CHRONICLE_PREFIXES = {
    upload: 'chronicle/media/pending',
    used: 'chronicle/media/published',
    meta: 'chronicle/metadata'
} as const;

function chronicleKey(bucket: keyof typeof CHRONICLE_PREFIXES, suffix: string): string {
    return `${CHRONICLE_PREFIXES[bucket]}/${suffix}`;
}

function stored(body: Uint8Array, contentType = 'application/octet-stream'): StoredObject {
    return { body: Uint8Array.from(body), size: body.byteLength, contentType, etag: `"${body.byteLength}"` };
}

class MemoryStorage implements ObjectStorage {
    objects = new Map<string, StoredObject>();
    puts: string[] = [];
    moves: Array<{ source: string; destination: string }> = [];
    deletes: string[] = [];
    failMetaOnce = false;
    failRollbackOnce = false;
    failDeleteAttempts = 0;

    async get(key: string) {
        const value = this.objects.get(key);
        return value ? { ...value, body: Uint8Array.from(value.body) } : null;
    }
    async put(key: string, body: Uint8Array, options?: PutObjectOptions) {
        this.puts.push(key);
        if (this.failMetaOnce && key.startsWith('chronicle/metadata/')) {
            this.failMetaOnce = false;
            throw new Error('injected metadata failure');
        }
        const value = stored(body, options?.contentType);
        this.objects.set(key, value);
        return value;
    }
    async delete(key: string) {
        this.deletes.push(key);
        if (this.failDeleteAttempts > 0) {
            this.failDeleteAttempts -= 1;
            throw new Error('injected delete failure');
        }
        this.objects.delete(key);
    }
    async exists(key: string) { return this.objects.has(key); }
    async copy(sourceKey: string, destinationKey: string) {
        const value = this.objects.get(sourceKey);
        if (!value) throw new Error('source not found');
        this.objects.set(destinationKey, { ...value, body: Uint8Array.from(value.body) });
    }
    async move(sourceKey: string, destinationKey: string) {
        this.moves.push({ source: sourceKey, destination: destinationKey });
        if (
            this.failRollbackOnce &&
            sourceKey.includes('/published/') && destinationKey.includes('/pending/')
        ) {
            this.failRollbackOnce = false;
            throw new Error('injected rollback failure');
        }
        await this.copy(sourceKey, destinationKey);
        this.objects.delete(sourceKey);
    }
    async list(prefix: string) {
        return [...this.objects.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, value]) => ({ key, size: value.size, etag: value.etag }));
    }
    async deletePrefix(prefix: string) {
        for (const key of [...this.objects.keys()]) if (key.startsWith(prefix)) this.objects.delete(key);
    }
    seed(key: string, body: Uint8Array, contentType = 'image/png') {
        this.objects.set(key, stored(body, contentType));
    }
    seedMeta(activityId: string, records: unknown[]) {
        this.seed(
            chronicleKey('meta', `${activityId}.json`),
            new TextEncoder().encode(JSON.stringify({ records })),
            'application/json'
        );
    }
    async records(activityId: string): Promise<Array<Record<string, unknown>>> {
        const value = await this.get(chronicleKey('meta', `${activityId}.json`));
        return value ? JSON.parse(new TextDecoder().decode(value.body)).records : [];
    }
}

class MemoryCompensation implements CompensationService {
    enqueues: Array<{ kind: string; payload: unknown }> = [];
    pending = new Set<string>();
    failEnqueue = false;

    async enqueue(kind: string, payload: unknown): Promise<string> {
        this.enqueues.push({ kind, payload });
        if (this.failEnqueue) throw new Error('injected compensation enqueue failure');
        const key = (payload as { key?: unknown })?.key;
        if (kind === 'delete-object' && typeof key === 'string') this.pending.add(key);
        return `compensation-${this.enqueues.length}`;
    }

    async run(storage: ObjectStorage, limit = 10): Promise<void> {
        for (const key of [...this.pending].slice(0, limit)) {
            try {
                await storage.delete(key);
                this.pending.delete(key);
            } catch {
                // Keep the operation pending for a later request.
            }
        }
    }
}

class MemoryIdempotencyStore implements IdempotencyStore {
    private ownershipBarrier: {
        reached: () => void;
        release: Promise<void>;
    } | null = null;
    private records = new Map<string, {
        fingerprint: string;
        state: 'started' | 'failed' | 'completed';
        generation: number;
        response?: IdempotencyResponse;
    }>();
    async claim(scope: string, key: string, fingerprint: string): Promise<IdempotencyClaim> {
        const id = `${scope}\0${key}`;
        const record = this.records.get(id);
        if (!record) {
            this.records.set(id, { fingerprint, state: 'started', generation: 1 });
            return { kind: 'acquired', recovered: false, generation: 1 };
        }
        if (record.fingerprint !== fingerprint) return { kind: 'conflict' };
        if (record.state === 'completed') return { kind: 'replay', response: record.response! };
        if (record.state === 'started') return { kind: 'in-progress' };
        record.state = 'started';
        record.generation += 1;
        return { kind: 'acquired', recovered: true, generation: record.generation };
    }
    async complete(
        scope: string,
        key: string,
        fingerprint: string,
        generation: number,
        response: IdempotencyResponse
    ) {
        const record = this.records.get(`${scope}\0${key}`);
        if (!record || record.fingerprint !== fingerprint || record.generation !== generation ||
            record.state !== 'started') throw new Error('Idempotency lease is no longer current');
        this.records.set(`${scope}\0${key}`, { fingerprint, generation, state: 'completed', response });
    }
    async fail(scope: string, key: string, fingerprint: string, generation: number) {
        const record = this.records.get(`${scope}\0${key}`);
        if (record?.fingerprint === fingerprint && record.generation === generation &&
            record.state === 'started') record.state = 'failed';
    }
    async isCurrent(scope: string, key: string, fingerprint: string, generation: number) {
        const record = this.records.get(`${scope}\0${key}`);
        const current = record?.fingerprint === fingerprint && record.generation === generation &&
            record.state === 'started';
        const barrier = this.ownershipBarrier;
        if (current && barrier) {
            this.ownershipBarrier = null;
            record.state = 'failed';
            barrier.reached();
            await barrier.release;
        }
        return current;
    }

    armOwnershipBarrier(): { reached: Promise<void>; release: () => void } {
        let markReached!: () => void;
        let release!: () => void;
        const reached = new Promise<void>((resolve) => { markReached = resolve; });
        const released = new Promise<void>((resolve) => { release = resolve; });
        this.ownershipBarrier = { reached: markReached, release: released };
        return { reached, release };
    }
}

class FixtureImages implements ImageProcessor {
    calls = 0;
    async validate(): Promise<ImageInfo> {
        this.calls += 1;
        return { format: 'png', width: 1, height: 1, contentType: 'image/png' };
    }
    async toWebp(body: Uint8Array) { return body; }
    async thumbnailPng(body: Uint8Array) { return body; }
    async resizeJpeg(body: Uint8Array) { return body; }
}

class FixtureUploads implements UploadParser {
    next: ParsedUpload = { fields: {}, files: {} };
    error: unknown = null;
    calls = 0;
    async parse() {
        this.calls += 1;
        if (this.error !== null) throw this.error;
        return this.next;
    }
}

class CapturingRateLimiter implements RateLimiter {
    private readonly buckets = new Map<string, Set<string>>();
    limit = 30;

    get identities(): Set<string> {
        return this.bucket('public-upload');
    }

    count(bucket: string): number {
        return this.bucket(bucket).size;
    }

    seed(bucket: string, count: number): void {
        const identities = this.bucket(bucket);
        while (identities.size < count) identities.add(`seed-${identities.size}`);
    }

    private bucket(name: string): Set<string> {
        let identities = this.buckets.get(name);
        if (!identities) {
            identities = new Set();
            this.buckets.set(name, identities);
        }
        return identities;
    }

    async consume(
        bucket: string,
        _key: string,
        limit: number,
        _windowSeconds: number,
        identity?: RateLimitIdentity
    ): Promise<RateLimitResult> {
        const identities = this.bucket(bucket);
        const effectiveLimit = bucket === 'public-upload' ? this.limit : limit;
        const eventIdentity = identity
            ? `${identity.operation}\0${identity.identity}`
            : `request\0${crypto.randomUUID()}`;
        if (identities.has(eventIdentity)) {
            return {
                allowed: true,
                remaining: effectiveLimit - identities.size,
                resetAt: Date.now() + 60_000
            };
        }
        if (identities.size >= effectiveLimit) {
            return { allowed: false, remaining: 0, resetAt: Date.now() + 60_000 };
        }
        identities.add(eventIdentity);
        return {
            allowed: true,
            remaining: effectiveLimit - identities.size,
            resetAt: Date.now() + 60_000
        };
    }
}

async function fixture() {
    const storage = new MemoryStorage();
    const idempotency = new MemoryIdempotencyStore();
    const uploads = new FixtureUploads();
    const images = new FixtureImages();
    const limiter = new CapturingRateLimiter();
    const compensation = new MemoryCompensation();
    const tokens = new HmacBackofficeTokenService('chronicle-contract-secret-at-least-32-bytes');
    const runtime: RuntimeServices = {
        storage,
        compensation,
        idempotency,
        uploads,
        images,
        rateLimiter: limiter,
        backofficeTokens: tokens
    };
    const token = await tokens.sign({
        id: 1,
        username: 'chronicle-op',
        producername: 'Chronicle Op',
        dept: 'op',
        csrfSecret: 'unused-for-authorization'
    }, 3600);
    return {
        app: createHonoApp(() => runtime),
        storage,
        compensation,
        idempotency,
        uploads,
        images,
        limiter,
        auth: { Authorization: token }
    };
}

function uploadRequest(app: ReturnType<typeof createHonoApp>, key?: string) {
    return app.request('/eventchronicle/upload', {
        method: 'POST',
        headers: {
            'Content-Type': 'multipart/form-data; boundary=fixture',
            ...(key ? { 'Idempotency-Key': key } : {})
        },
        body: '--fixture--'
    });
}

function unreadUploadRequest(app: ReturnType<typeof createHonoApp>, key: string) {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode('--fixture--'));
        },
        pull(controller) {
            pulls += 1;
            controller.close();
        }
    });
    const request = new Request('http://ims.test/eventchronicle/upload', {
        method: 'POST',
        headers: {
            'Content-Type': 'multipart/form-data; boundary=fixture',
            'Idempotency-Key': key
        },
        body,
        duplex: 'half'
    } as RequestInit & { duplex: 'half' });
    return { response: app.fetch(request), pulls: () => pulls };
}

test('Chronicle upload replays success and charges every conflicting attempt', async () => {
    const { app, storage, uploads, images, limiter } = await fixture();
    uploads.next = {
        fields: { activityId: '42', username: 'producer' },
        files: {
            images: {
                filename: 'photo.png',
                contentType: 'image/png',
                body: new TextEncoder().encode('valid-png')
            }
        }
    };

    const first = await uploadRequest(app, 'upload-key');
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { success: true, count: 1 });
    const uploadKeys = () => [...storage.objects.keys()].filter((key) => key.includes('/pending/'));
    assert.equal(uploadKeys().length, 1);
    const putCount = storage.puts.length;

    const replay = await uploadRequest(app, 'upload-key');
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), { success: true, count: 1 });
    assert.equal(storage.puts.length, putCount);
    assert.equal(uploadKeys().length, 1);

    uploads.next.fields.username = 'different-producer';
    const conflict = await uploadRequest(app, 'upload-key');
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { error: '幂等键与请求不匹配' });
    assert.equal((await uploadRequest(app, 'upload-key')).status, 409);
    assert.equal(limiter.identities.size, 3, JSON.stringify([...limiter.identities]));
    assert.equal(images.calls, 1);
});

test('Chronicle rejects malformed idempotency keys before multipart and image parsing', async () => {
    const { app, uploads, images, limiter } = await fixture();
    for (const key of ['', 'x'.repeat(201)]) {
        const response = await app.fetch(new Request('http://ims.test/eventchronicle/upload', {
            method: 'POST',
            headers: {
                'Content-Type': 'multipart/form-data; boundary=fixture',
                'Idempotency-Key': key
            },
            body: '--fixture--'
        }));
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), { error: '无效的幂等键' });
    }
    assert.equal(uploads.calls, 0);
    assert.equal(images.calls, 0);
    assert.equal(limiter.identities.size, 0);
});

test('Chronicle write-key quota rejects a distinct request without pulling its body', async () => {
    const { app, storage, uploads, images, limiter } = await fixture();
    limiter.seed(CHRONICLE_UPLOAD_WRITE_LIMIT.bucket, CHRONICLE_UPLOAD_WRITE_LIMIT.limit);
    const blocked = unreadUploadRequest(app, 'write-overflow');

    const response = await blocked.response;
    assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), { error: 'Too many requests' });
    assert.equal(blocked.pulls(), 0);
    assert.equal(uploads.calls, 0);
    assert.equal(images.calls, 0);
    assert.equal(storage.puts.length, 0);
    assert.equal(
        limiter.count(CHRONICLE_UPLOAD_WRITE_LIMIT.bucket),
        CHRONICLE_UPLOAD_WRITE_LIMIT.limit
    );
    assert.equal(limiter.count(CHRONICLE_UPLOAD_ATTEMPT_LIMIT.bucket), 1);
});

test('Chronicle uploads without an idempotency key spend write quota per request', async () => {
    const { app, uploads, limiter } = await fixture();
    uploads.next = {
        fields: { activityId: 'unkeyed-limit', username: 'producer' },
        files: {
            images: {
                filename: 'photo.png',
                contentType: 'image/png',
                body: new TextEncoder().encode('valid-png')
            }
        }
    };

    assert.equal((await uploadRequest(app)).status, 200);
    assert.equal((await uploadRequest(app)).status, 200);
    assert.equal(limiter.count(CHRONICLE_UPLOAD_WRITE_LIMIT.bucket), 2);
    assert.equal(limiter.count(CHRONICLE_UPLOAD_ATTEMPT_LIMIT.bucket), 2);
});

test('Chronicle upload hides unmarked metadata failures and reports them as server errors', async (t) => {
    const logged = t.mock.method(console, 'error', () => undefined);
    const { app, storage, uploads } = await fixture();
    uploads.next = {
        fields: { activityId: 'metadata-failure', username: 'producer' },
        files: {
            images: {
                filename: 'photo.png',
                contentType: 'image/png',
                body: new TextEncoder().encode('valid-png')
            }
        }
    };
    storage.failMetaOnce = true;

    const response = await uploadRequest(app);
    assert.equal(response.status, 500);
    const body = await response.json() as { success: boolean; error: string };
    assert.deepEqual(body, { success: false, error: '服务器错误' });
    assert.equal(JSON.stringify(body).includes('injected metadata failure'), false);
    assert.equal(logged.mock.callCount(), 1);
    assert.equal(logged.mock.calls[0]?.arguments[0], 'Chronicle upload failed');
});

test('Chronicle upload preserves explicit parser 400 and 413 responses', async (t) => {
    const logged = t.mock.method(console, 'error', () => undefined);
    for (const status of [400, 413] as const) {
        const { app, uploads } = await fixture();
        uploads.error = Object.assign(new Error(`parser rejected with ${status}`), { status });

        const response = await uploadRequest(app);
        assert.equal(response.status, status);
        assert.deepEqual(await response.json(), {
            success: false,
            error: `parser rejected with ${status}`
        });
    }
    assert.equal(logged.mock.callCount(), 0);
});

test('Chronicle attempt quota bounds same-key parsing without spending write quota twice', async () => {
    const { app, storage, uploads, limiter } = await fixture();
    uploads.next = {
        fields: { activityId: 'attempt-limit', username: 'producer' },
        files: {
            images: {
                filename: 'photo.png',
                contentType: 'image/png',
                body: new TextEncoder().encode('valid-png')
            }
        }
    };
    assert.equal((await uploadRequest(app, 'attempt-key')).status, 200);
    assert.equal(limiter.count(CHRONICLE_UPLOAD_WRITE_LIMIT.bucket), 1);
    limiter.seed(CHRONICLE_UPLOAD_ATTEMPT_LIMIT.bucket, CHRONICLE_UPLOAD_ATTEMPT_LIMIT.limit);
    const parserCalls = uploads.calls;
    const putCount = storage.puts.length;
    const blocked = unreadUploadRequest(app, 'attempt-key');

    const response = await blocked.response;
    assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), { error: 'Too many requests' });
    assert.equal(blocked.pulls(), 0);
    assert.equal(uploads.calls, parserCalls);
    assert.equal(storage.puts.length, putCount);
    assert.equal(limiter.count(CHRONICLE_UPLOAD_WRITE_LIMIT.bucket), 1);
});

test('Chronicle conflict payloads spend quota before image validation', async () => {
    const { app, uploads, images, limiter } = await fixture();
    limiter.limit = 1;
    uploads.next = {
        fields: { activityId: 'rate-conflict', username: 'first' },
        files: {
            images: {
                filename: 'photo.png',
                contentType: 'image/png',
                body: new TextEncoder().encode('same-image')
            }
        }
    };
    assert.equal((await uploadRequest(app, 'shared-key')).status, 200);
    assert.equal(images.calls, 1);

    uploads.next.fields.username = 'conflicting-payload';
    const blocked = await uploadRequest(app, 'shared-key');
    assert.equal(blocked.status, 429);
    assert.deepEqual(await blocked.json(), { error: 'Too many requests' });
    assert.equal(uploads.calls, 2);
    assert.equal(images.calls, 1);
});

test('Chronicle used-media queries isolate activity directory prefixes', async () => {
    const { app, storage } = await fixture();
    storage.seed(chronicleKey('used', '10/ten.png'), new Uint8Array([10]));
    storage.seed(chronicleKey('used', '1/one.png'), new Uint8Array([1]));
    storage.seedMeta('1', []);
    storage.seedMeta('10', []);

    const detailResponse = await app.request('/eventchronicle/activities/1');
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json() as { images: string[] };
    assert.deepEqual(detail.images, [
        '/assets/images/eventchronicle/events/used/1/one.png'
    ]);

    const listResponse = await app.request('/eventchronicle/activities');
    assert.equal(listResponse.status, 200);
    const activities = await listResponse.json() as Array<{ id: string; cover: string | null }>;
    const covers = new Map(activities.map((activity) => [activity.id, activity.cover]));
    assert.equal(covers.get('1'), '/assets/images/eventchronicle/events/used/1/one.png');
    assert.equal(covers.get('10'), '/assets/images/eventchronicle/events/used/10/ten.png');
});

test('Chronicle approval resumes after metadata and rollback failures, then replays success', async () => {
    const { app, storage, auth } = await fixture();
    const activityId = '7';
    const filename = 'pending.png';
    storage.seed(chronicleKey('upload', `${activityId}/${filename}`), new Uint8Array([1]));
    storage.seedMeta(activityId, [{ filename, status: 'pending' }]);
    storage.failMetaOnce = true;
    storage.failRollbackOnce = true;
    const url = `/eventchronicle/admin/approve/${activityId}/${filename}`;
    const request = () => app.request(url, {
        method: 'POST', headers: { ...auth, 'Idempotency-Key': 'approve-key' }
    });

    assert.equal((await request()).status, 500);
    assert.equal(await storage.exists(chronicleKey('upload', `${activityId}/${filename}`)), false);
    assert.equal(await storage.exists(chronicleKey('used', `${activityId}/${filename}`)), true);
    assert.equal((await storage.records(activityId))[0]?.status, 'pending');

    const recovered = await request();
    assert.equal(recovered.status, 200);
    assert.deepEqual(await recovered.json(), { success: true });
    assert.equal((await storage.records(activityId))[0]?.status, 'approved');
    const moveCount = storage.moves.length;
    const replay = await request();
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), { success: true });
    assert.equal(storage.moves.length, moveCount);

    const conflict = await app.request(`/eventchronicle/admin/approve/${activityId}/other.png`, {
        method: 'POST', headers: { ...auth, 'Idempotency-Key': 'approve-key' }
    });
    assert.equal(conflict.status, 409);
});

test('Chronicle takeover barriers preserve the replacement result for every admin mutation', async () => {
    const cases = [
        {
            label: 'approve',
            method: 'POST',
            route: 'approve',
            sourceBucket: 'upload',
            finalBucket: 'used',
            initialStatus: 'pending',
            finalStatus: 'approved'
        },
        {
            label: 'reject',
            method: 'POST',
            route: 'reject',
            sourceBucket: 'upload',
            finalBucket: null,
            initialStatus: 'pending',
            finalStatus: null
        },
        {
            label: 'delete-used',
            method: 'DELETE',
            route: 'delete-used',
            sourceBucket: 'used',
            finalBucket: null,
            initialStatus: 'approved',
            finalStatus: null
        }
    ] as const;

    for (const mutation of cases) {
        const { app, storage, idempotency, auth } = await fixture();
        const activityId = `takeover-${mutation.label}`;
        const filename = 'item.png';
        const source = chronicleKey(mutation.sourceBucket, `${activityId}/${filename}`);
        storage.seed(source, new Uint8Array([1]));
        storage.seedMeta(activityId, [{ filename, status: mutation.initialStatus }]);
        const barrier = idempotency.armOwnershipBarrier();
        const invoke = () => Promise.resolve(app.request(
            `/eventchronicle/admin/${mutation.route}/${activityId}/${filename}`,
            {
                method: mutation.method,
                headers: { ...auth, 'Idempotency-Key': `${mutation.label}-takeover-key` }
            }
        ));

        const staleResponse = invoke();
        await barrier.reached;
        const replacement = await invoke().finally(() => barrier.release());
        assert.equal(replacement.status, 200, `${mutation.label} replacement`);
        assert.equal((await staleResponse).status, 500, `${mutation.label} stale owner`);
        assert.equal((await invoke()).status, 200, `${mutation.label} replay`);

        assert.equal(await storage.exists(source), false, `${mutation.label} source`);
        const records = await storage.records(activityId);
        if (mutation.finalStatus) {
            assert.equal(records[0]?.status, mutation.finalStatus, `${mutation.label} metadata`);
            assert.equal(
                await storage.exists(chronicleKey(
                    mutation.finalBucket,
                    `${activityId}/${filename}`
                )),
                true,
                `${mutation.label} destination`
            );
        } else {
            assert.deepEqual(records, [], `${mutation.label} metadata`);
            assert.equal(
                [...storage.objects.keys()].some((key) => key.startsWith('chronicle/trash/')),
                false,
                `${mutation.label} trash`
            );
            assert.equal(storage.moves.length, 0, `${mutation.label} does not move before delete`);
        }
        assert.equal(
            storage.moves.some(({ source: movedSource, destination }) =>
                movedSource.includes('/published/') && destination.includes('/pending/')),
            false,
            `${mutation.label} never rolls back a shared destination`
        );
    }
});

test('Chronicle reject and used-delete operations replay without duplicate side effects', async () => {
    const { app, storage, auth } = await fixture();
    storage.seed(chronicleKey('upload', '8/reject.png'), new Uint8Array([1]));
    storage.seedMeta('8', [{ filename: 'reject.png', status: 'pending' }]);
    const reject = () => app.request('/eventchronicle/admin/reject/8/reject.png', {
        method: 'POST', headers: { ...auth, 'Idempotency-Key': 'reject-key' }
    });
    assert.equal((await reject()).status, 200);
    const movesAfterReject = storage.moves.length;
    assert.equal((await reject()).status, 200);
    assert.equal(storage.moves.length, movesAfterReject);

    storage.seed(chronicleKey('used', '9/delete.png'), new Uint8Array([2]));
    storage.seedMeta('9', [{ filename: 'delete.png', status: 'approved' }]);
    const remove = () => app.request('/eventchronicle/admin/delete-used/9/delete.png', {
        method: 'DELETE', headers: { ...auth, 'Idempotency-Key': 'delete-key' }
    });
    assert.equal((await remove()).status, 200);
    const movesAfterDelete = storage.moves.length;
    assert.equal((await remove()).status, 200);
    assert.equal(storage.moves.length, movesAfterDelete);
});

test('Chronicle committed deletions stay successful when cleanup and compensation both fail', async (t) => {
    const logged = t.mock.method(console, 'error', () => undefined);
    const cases = [
        { label: 'reject-unkeyed', route: 'reject', method: 'POST', bucket: 'upload', status: 'pending', keyed: false },
        { label: 'reject-keyed', route: 'reject', method: 'POST', bucket: 'upload', status: 'pending', keyed: true },
        { label: 'delete-used-unkeyed', route: 'delete-used', method: 'DELETE', bucket: 'used', status: 'approved', keyed: false },
        { label: 'delete-used-keyed', route: 'delete-used', method: 'DELETE', bucket: 'used', status: 'approved', keyed: true }
    ] as const;

    for (const mutation of cases) {
        const { app, storage, compensation, auth } = await fixture();
        const activityId = `cleanup-${mutation.label}`;
        const filename = 'item.png';
        const source = chronicleKey(mutation.bucket, `${activityId}/${filename}`);
        storage.seed(source, new Uint8Array([1]));
        storage.seedMeta(activityId, [{ filename, status: mutation.status }]);
        storage.failDeleteAttempts = 1;
        compensation.failEnqueue = true;
        const request = () => app.request(
            `/eventchronicle/admin/${mutation.route}/${activityId}/${filename}`,
            {
                method: mutation.method,
                headers: {
                    ...auth,
                    ...(mutation.keyed ? { 'Idempotency-Key': `${mutation.label}-key` } : {})
                }
            }
        );

        const first = await request();
        assert.equal(first.status, 200, mutation.label);
        assert.deepEqual(await first.json(), { success: true }, mutation.label);
        assert.deepEqual(await storage.records(activityId), [], `${mutation.label} metadata`);
        assert.equal(storage.deletes.length, 1, `${mutation.label} delete attempts`);
        assert.equal(compensation.enqueues.length, 1, `${mutation.label} enqueue attempts`);

        if (mutation.keyed) {
            assert.equal(await storage.exists(source), true, `${mutation.label} retained source`);
            const replay = await request();
            assert.equal(replay.status, 200, `${mutation.label} replay`);
            assert.deepEqual(await replay.json(), { success: true }, `${mutation.label} replay body`);
            assert.equal(storage.deletes.length, 1, `${mutation.label} replay delete attempts`);
            assert.equal(compensation.enqueues.length, 1, `${mutation.label} replay enqueue attempts`);
        } else {
            assert.equal(await storage.exists(source), false, `${mutation.label} source moved`);
            assert.equal(
                [...storage.objects.keys()].some((key) => key.startsWith('chronicle/trash/')),
                true,
                `${mutation.label} retained trash`
            );
        }
    }

    assert.equal(logged.mock.callCount(), cases.length);
});

test('Chronicle committed deletion compensation still converges on a later request', async () => {
    const { app, storage, compensation, auth } = await fixture();
    const activityId = 'cleanup-convergence';
    const filename = 'item.png';
    const source = chronicleKey('upload', `${activityId}/${filename}`);
    storage.seed(source, new Uint8Array([1]));
    storage.seedMeta(activityId, [{ filename, status: 'pending' }]);
    storage.failDeleteAttempts = 1;
    const request = () => app.request(`/eventchronicle/admin/reject/${activityId}/${filename}`, {
        method: 'POST',
        headers: { ...auth, 'Idempotency-Key': 'cleanup-convergence-key' }
    });

    assert.equal((await request()).status, 200);
    assert.equal(await storage.exists(source), true);
    assert.equal(compensation.enqueues.length, 1);
    assert.equal(compensation.pending.has(source), true);

    const replay = await request();
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), { success: true });
    assert.equal(await storage.exists(source), false);
    assert.equal(compensation.pending.size, 0);
    assert.equal(compensation.enqueues.length, 1);
    assert.equal(storage.deletes.length, 2);
});
