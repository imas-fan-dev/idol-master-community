import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createHonoApp } from '@/app';
import type { RateLimiter } from '@/ports/cache';
import type { ParsedUpload, UploadParser, UploadedFile } from '@/ports/http';
import type { ImageInfo, ImageProcessor } from '@/ports/media';
import type { ObjectStorage, PutObjectOptions, StoredObject } from '@/ports/object-storage';
import type {
    CreateOwnedFudabaOfficeInput,
    FudabaOfficeCreateResult,
    FudabaOfficeMutationResult,
    FudabaOwnerOfficeRecord,
    FudabaRepository,
    PlatformAccountStatus,
    UpdateOwnedFudabaOfficeInput
} from '@/ports/repositories';
import type { RuntimeServices } from '@/ports/runtime-services';

const ACCOUNT_ID = 'office-owner';
const OTHER_ACCOUNT_ID = 'other-owner';
const PLATFORM_TOKEN = 'office-platform-token';
const CSRF_SECRET = 'office-csrf-secret';
const CREATED_AT = '2026-08-03T01:00:00.000Z';
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0x01]);

function csrfHash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function officeRecord(
    overrides: Partial<FudabaOwnerOfficeRecord> = {}
): FudabaOwnerOfficeRecord {
    return {
        id: 'owner-office',
        owner_account_id: ACCOUNT_ID,
        slug: 'owner-office',
        name: 'Owner Office',
        intro: 'Owner intro',
        city: 'Shanghai',
        address: 'Private exact address',
        latitude: 31.2304,
        longitude: 121.4737,
        accent: '#ef5b6c',
        cover_object_key: 'protected/fudaba/offices/owner-office/cover.webp',
        pending_cover_object_key: null,
        pending_cover_submitted_at: null,
        is_open: true,
        visitor_count: 8,
        status: 'active',
        revision: 0,
        created_at: CREATED_AT,
        updated_at: CREATED_AT,
        archived_at: null,
        series_codes: ['765'],
        ...overrides
    };
}

function officeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        name: 'New Office',
        intro: 'Office intro',
        city: 'Shanghai',
        address: '765 Producer Street',
        latitude: 31.2304,
        longitude: 121.4737,
        accent: '#ef5b6c',
        isOpen: true,
        seriesCodes: ['765'],
        ...overrides
    };
}

function uploadedFile(): UploadedFile {
    return { filename: 'cover.jpg', contentType: 'image/jpeg', body: JPEG_BYTES };
}

class ControlledUploads implements UploadParser {
    next: ParsedUpload = {
        fields: { expectedRevision: '0' },
        files: { image: uploadedFile() }
    };
    readonly calls: Array<Parameters<UploadParser['parse']>[1]> = [];

    async parse(
        _request: Request,
        options: Parameters<UploadParser['parse']>[1]
    ): Promise<ParsedUpload> {
        this.calls.push(options);
        return this.next;
    }
}

class CoverImages implements ImageProcessor {
    async validate(body: Uint8Array, declaredType?: string): Promise<ImageInfo> {
        if (body[0] === 0xff) {
            return {
                format: 'jpeg', width: 1200, height: 800,
                contentType: 'image/jpeg'
            };
        }
        if (body[0] === 0x52 && declaredType === 'image/webp') {
            return {
                format: 'webp', width: 1200, height: 800,
                contentType: 'image/webp'
            };
        }
        throw new Error('unexpected image');
    }

    async toWebp(): Promise<Uint8Array> {
        return new Uint8Array([0x52, 0x49, 0x46, 0x46]);
    }

    async thumbnailPng(): Promise<Uint8Array> {
        throw new Error('unused');
    }

    async resizeJpeg(): Promise<Uint8Array> {
        throw new Error('unused');
    }
}

class CoverStorage {
    readonly objects = new Map<string, { stored: StoredObject; options: PutObjectOptions }>();
    readonly puts: Array<{ key: string; options: PutObjectOptions }> = [];
    readonly deletes: string[] = [];
    readonly ownedDeletes: Array<{ key: string; ownerToken: string }> = [];
    readonly reads: Array<{ key: string; method?: 'GET' | 'HEAD' }> = [];
    readonly events: string[] = [];
    failPut = false;
    failPutAfterStore = false;
    afterPut: (() => void | Promise<void>) | null = null;

    seed(key: string): void {
        this.objects.set(key, {
            stored: {
                body: new Uint8Array([0x52]),
                size: 1,
                contentType: 'image/webp',
                etag: `seed-${key}`
            },
            options: { protectedAccess: true }
        });
    }

    async get(key: string): Promise<StoredObject | null> {
        return this.objects.get(key)?.stored ?? null;
    }

    async createReadUrl(key: string, options?: { method?: 'GET' | 'HEAD' }) {
        this.reads.push({ key, method: options?.method });
        return this.objects.has(key)
            ? {
                url: `https://private.example.test/${encodeURIComponent(key)}`,
                visibility: 'private' as const
            }
            : null;
    }

    async put(
        key: string,
        body: Uint8Array,
        options: PutObjectOptions = {}
    ): Promise<StoredObject> {
        this.events.push('put');
        this.puts.push({ key, options });
        if (this.failPut) throw new Error('injected cover put failure');
        const stored = {
            body,
            size: body.byteLength,
            contentType: options.contentType ?? 'application/octet-stream',
            etag: `etag-${this.puts.length}`
        };
        this.objects.set(key, { stored, options });
        await this.afterPut?.();
        if (this.failPutAfterStore) {
            throw new Error('injected uncertain cover put failure');
        }
        return stored;
    }

    async delete(key: string): Promise<void> {
        this.events.push('delete');
        this.deletes.push(key);
        this.objects.delete(key);
    }

    async deleteIfOwned(key: string, ownerToken: string): Promise<boolean> {
        this.events.push('owned-delete');
        this.ownedDeletes.push({ key, ownerToken });
        const current = this.objects.get(key);
        if (current?.options.ownerToken !== ownerToken) return false;
        this.objects.delete(key);
        return true;
    }

    async exists(key: string): Promise<boolean> {
        return this.objects.has(key);
    }

    async copy(): Promise<void> { throw new Error('unused'); }
    async move(): Promise<void> { throw new Error('unused'); }
    async list(): Promise<[]> { return []; }
    async deletePrefix(): Promise<void> {}
}

class ControlledRateLimiter implements RateLimiter {
    readonly deniedBuckets = new Set<string>();
    readonly calls: string[] = [];

    async consume(
        bucket: string,
        _key: string,
        limit: number
    ): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
        this.calls.push(bucket);
        const allowed = !this.deniedBuckets.has(bucket);
        return {
            allowed,
            remaining: allowed ? limit - 1 : 0,
            resetAt: Date.now() + 60_000
        };
    }
}

class OfficeRouteFixture {
    accountStatus: PlatformAccountStatus = 'active';
    writeEnabled = true;
    readonly offices = new Map<string, FudabaOwnerOfficeRecord>();
    readonly receipts = new Map<string, { requestHash: string; officeId: string }>();
    readonly uploads = new ControlledUploads();
    readonly images = new CoverImages();
    readonly storage = new CoverStorage();
    readonly rateLimiter = new ControlledRateLimiter();
    readonly createInputs: CreateOwnedFudabaOfficeInput[] = [];
    readonly updateInputs: UpdateOwnedFudabaOfficeInput[] = [];
    readonly events = this.storage.events;
    reserveMode: 'saved' | 'mutate-then-throw' = 'saved';
    clearMode: 'saved' | 'unavailable' | 'throw' | 'promote' = 'saved';
    clearAttempts = 0;
    failOwnerReadAfterPut = false;
    readonly app: ReturnType<typeof createHonoApp>;
    readonly session = {
        id: 'office-session',
        account_id: ACCOUNT_ID,
        token_hash: 'refresh-hash',
        previous_token_hash: null,
        csrf_hash: csrfHash(CSRF_SECRET),
        expires_at: Date.now() + 3_600_000,
        created_at: Date.now(),
        updated_at: Date.now(),
        revoked_at: null
    };

    constructor() {
        const owner = officeRecord();
        const other = officeRecord({
            id: 'other-office',
            owner_account_id: OTHER_ACCOUNT_ID,
            slug: 'other-office',
            cover_object_key: 'protected/fudaba/offices/other-office/cover.webp'
        });
        this.offices.set(owner.id, owner);
        this.offices.set(other.id, other);
        this.storage.seed(owner.cover_object_key!);
        this.storage.seed(other.cover_object_key!);
        this.app = createHonoApp(() => this.runtime());
    }

    private ownerOffice(officeId: string, ownerAccountId: string) {
        const office = this.offices.get(officeId);
        return office?.owner_account_id === ownerAccountId ? office : null;
    }

    private saved(office: FudabaOwnerOfficeRecord): FudabaOfficeMutationResult {
        return { status: 'saved', office: { ...office }, previousPendingObjectKey: null };
    }

    readonly fudaba = {
        listOfficesForOwner: async (ownerAccountId: string) =>
            [...this.offices.values()]
                .filter((office) => office.owner_account_id === ownerAccountId)
                .map((office) => ({ ...office })),
        findOfficeForOwner: async (officeId: string, ownerAccountId: string) => {
            if (this.failOwnerReadAfterPut && this.storage.puts.length > 0) {
                throw new Error('injected owner office confirmation failure');
            }
            const office = this.ownerOffice(officeId, ownerAccountId);
            return office ? { ...office } : null;
        },
        createOfficeForOwner: async (
            input: CreateOwnedFudabaOfficeInput
        ): Promise<FudabaOfficeCreateResult> => {
            this.createInputs.push(input);
            const receipt = this.receipts.get(input.idempotencyKeyHash);
            if (receipt) {
                if (receipt.requestHash !== input.requestHash) {
                    return { status: 'idempotency-conflict' };
                }
                return this.saved(this.offices.get(receipt.officeId)!);
            }
            const created = officeRecord({
                id: input.id,
                owner_account_id: input.ownerAccountId,
                slug: input.slug,
                name: input.name,
                intro: input.intro,
                city: input.city,
                address: input.address,
                latitude: input.latitude,
                longitude: input.longitude,
                accent: input.accent,
                cover_object_key: null,
                visitor_count: 0,
                is_open: input.isOpen,
                status: 'active',
                revision: 0,
                created_at: input.createdAt,
                updated_at: input.updatedAt,
                archived_at: null,
                series_codes: input.seriesCodes
            });
            this.offices.set(created.id, created);
            this.receipts.set(input.idempotencyKeyHash, {
                requestHash: input.requestHash,
                officeId: created.id
            });
            return this.saved(created);
        },
        updateOfficeForOwner: async (
            input: UpdateOwnedFudabaOfficeInput
        ): Promise<FudabaOfficeMutationResult> => {
            this.updateInputs.push(input);
            const current = this.ownerOffice(input.officeId, input.ownerAccountId);
            if (!current) return { status: 'unavailable' };
            if (current.revision !== input.expectedRevision) {
                return { status: 'conflict', revision: current.revision };
            }
            if (current.status !== 'active') {
                return {
                    status: 'state-conflict', revision: current.revision,
                    officeStatus: current.status
                };
            }
            Object.assign(current, {
                name: input.name,
                intro: input.intro,
                city: input.city,
                address: input.address,
                latitude: input.latitude,
                longitude: input.longitude,
                accent: input.accent,
                is_open: input.isOpen,
                series_codes: input.seriesCodes,
                revision: current.revision + 1,
                updated_at: input.updatedAt
            });
            return this.saved(current);
        },
        archiveOfficeForOwner: async (input: {
            officeId: string; ownerAccountId: string;
            expectedRevision: number; archivedAt: string;
        }): Promise<FudabaOfficeMutationResult> => {
            const current = this.ownerOffice(input.officeId, input.ownerAccountId);
            if (!current) return { status: 'unavailable' };
            if (current.revision !== input.expectedRevision) {
                return { status: 'conflict', revision: current.revision };
            }
            if (current.status !== 'active') {
                return {
                    status: 'state-conflict', revision: current.revision,
                    officeStatus: current.status
                };
            }
            Object.assign(current, {
                status: 'archived', archived_at: input.archivedAt,
                updated_at: input.archivedAt, revision: current.revision + 1
            });
            return this.saved(current);
        },
        restoreOfficeForOwner: async (input: {
            officeId: string; ownerAccountId: string;
            expectedRevision: number; restoredAt: string;
        }): Promise<FudabaOfficeMutationResult> => {
            const current = this.ownerOffice(input.officeId, input.ownerAccountId);
            if (!current) return { status: 'unavailable' };
            if (current.revision !== input.expectedRevision) {
                return { status: 'conflict', revision: current.revision };
            }
            if (current.status !== 'archived') {
                return {
                    status: 'state-conflict', revision: current.revision,
                    officeStatus: current.status
                };
            }
            Object.assign(current, {
                status: 'active', archived_at: null,
                updated_at: input.restoredAt, revision: current.revision + 1
            });
            return this.saved(current);
        },
        reservePendingOfficeCoverForOwner: async (input: {
            officeId: string; ownerAccountId: string; objectKey: string;
            expectedRevision: number; submittedAt: string;
        }): Promise<FudabaOfficeMutationResult> => {
            const current = this.ownerOffice(input.officeId, input.ownerAccountId);
            if (!current) return { status: 'unavailable' };
            if (current.revision !== input.expectedRevision) {
                return { status: 'conflict', revision: current.revision };
            }
            if (current.status !== 'active') {
                return {
                    status: 'state-conflict', revision: current.revision,
                    officeStatus: current.status
                };
            }
            if (current.pending_cover_object_key) {
                return { status: 'pending-exists', revision: current.revision };
            }
            this.events.push('reserve');
            Object.assign(current, {
                pending_cover_object_key: input.objectKey,
                pending_cover_submitted_at: input.submittedAt,
                updated_at: input.submittedAt,
                revision: current.revision + 1
            });
            if (this.reserveMode === 'mutate-then-throw') {
                throw new Error('connection lost after reserve');
            }
            return this.saved(current);
        },
        clearPendingOfficeCoverForOwner: async (input: {
            officeId: string; ownerAccountId: string; objectKey: string;
            expectedRevision: number; updatedAt: string;
        }): Promise<FudabaOfficeMutationResult> => {
            this.clearAttempts += 1;
            const current = this.ownerOffice(input.officeId, input.ownerAccountId);
            if (!current) return { status: 'unavailable' };
            if (this.clearMode === 'throw') {
                throw new Error('injected cover release failure');
            }
            if (this.clearMode === 'unavailable') return { status: 'unavailable' };
            if (this.clearMode === 'promote') {
                Object.assign(current, {
                    cover_object_key: input.objectKey,
                    pending_cover_object_key: null,
                    pending_cover_submitted_at: null,
                    revision: current.revision + 1,
                    updated_at: input.updatedAt
                });
                return { status: 'unavailable' };
            }
            if (current.revision !== input.expectedRevision) {
                return { status: 'conflict', revision: current.revision };
            }
            if (current.pending_cover_object_key !== input.objectKey) {
                return {
                    status: 'state-conflict', revision: current.revision,
                    officeStatus: current.status
                };
            }
            this.events.push('release');
            Object.assign(current, {
                pending_cover_object_key: null,
                pending_cover_submitted_at: null,
                updated_at: input.updatedAt,
                revision: current.revision + 1
            });
            return {
                status: 'saved',
                office: { ...current },
                previousPendingObjectKey: input.objectKey
            };
        }
    } as unknown as FudabaRepository;

    runtime(): RuntimeServices {
        return {
            fudaba: this.fudaba,
            uploads: this.uploads,
            images: this.images,
            storage: this.storage as unknown as ObjectStorage,
            compensation: {
                enqueue: async () => 'compensation',
                run: async () => undefined
            },
            rateLimiter: this.rateLimiter,
            platformAccounts: {
                findRefreshSessionById: async (id: string) =>
                    id === this.session.id ? { ...this.session } : null,
                findAccountWithProfileById: async (id: string) => id === ACCOUNT_ID
                    ? {
                        account: {
                            id: ACCOUNT_ID,
                            status: this.accountStatus,
                            token_version: 0,
                            created_at: 500,
                            updated_at: 500,
                            deleted_at: null
                        },
                        profile: {
                            account_id: ACCOUNT_ID,
                            display_name: 'Office Owner',
                            avatar_object_key: null,
                            avatar_external_url: null,
                            home_city: 'Shanghai',
                            bio: '',
                            updated_at: 500
                        }
                    }
                    : null,
                revokeRefreshSession: async () => true
            } as unknown as NonNullable<RuntimeServices['platformAccounts']>,
            platformTokens: {
                async sign() { return PLATFORM_TOKEN; },
                async verify(token: string) {
                    if (token !== PLATFORM_TOKEN) throw new Error('wrong token');
                    const now = Math.floor(Date.now() / 1000);
                    return {
                        iss: 'imsweb' as const,
                        aud: 'ims-platform' as const,
                        kind: 'platform' as const,
                        id: ACCOUNT_ID,
                        tokenVersion: 0,
                        sessionId: 'office-session',
                        csrfSecret: CSRF_SECRET,
                        jti: 'office-access',
                        iat: now,
                        exp: now + 900
                    };
                }
            },
            config: {
                fudabaPublicReadEnabled: false,
                fudabaWriteEnabled: this.writeEnabled
            }
        };
    }
}

function bearerHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${PLATFORM_TOKEN}`, ...extra };
}

async function createOffice(
    fixture: OfficeRouteFixture,
    key: string,
    body = officeBody()
): Promise<Response> {
    return fixture.app.request('http://ims.test/api/community/exchange/offices', {
        method: 'POST',
        headers: bearerHeaders({
            'content-type': 'application/json',
            'idempotency-key': key
        }),
        body: JSON.stringify(body)
    });
}

async function uploadCover(
    fixture: OfficeRouteFixture,
    officeId = 'owner-office'
): Promise<Response> {
    return fixture.app.request(
        `http://ims.test/api/community/exchange/me/offices/${officeId}/cover`,
        { method: 'PUT', headers: bearerHeaders(), body: new FormData() }
    );
}

test('owner office reads ignore public/write flags and never expose object keys', async () => {
    const fixture = new OfficeRouteFixture();
    fixture.writeEnabled = false;
    const list = await fixture.app.request(
        'http://ims.test/api/community/exchange/me/offices',
        { headers: bearerHeaders() }
    );
    assert.equal(list.status, 200);
    const serialized = JSON.stringify(await list.json());
    assert.equal(serialized.includes('object_key'), false);
    assert.equal(serialized.includes('protected/fudaba'), false);
    assert.match(serialized, /media\/cover/);
    assert.equal((await fixture.app.request(
        'http://ims.test/api/community/exchange/me/offices/other-office',
        { headers: bearerHeaders() }
    )).status, 404);
    assert.equal((await fixture.app.request(
        'http://ims.test/api/community/exchange/me/offices'
    )).status, 401);
});

test('office creation requires persistent idempotency and replays one resource', async () => {
    const fixture = new OfficeRouteFixture();
    const missingKey = await fixture.app.request(
        'http://ims.test/api/community/exchange/offices',
        {
            method: 'POST',
            headers: bearerHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify(officeBody())
        }
    );
    assert.equal(missingKey.status, 400);
    assert.equal(fixture.createInputs.length, 0);

    const created = await createOffice(fixture, 'create-office-key');
    const createdBody = await created.json() as { office?: { id: string } };
    assert.equal(created.status, 201, JSON.stringify(createdBody));
    assert.ok(createdBody.office?.id);
    assert.equal(fixture.createInputs[0]?.status, 'active');
    assert.equal(fixture.createInputs[0]?.revision, 0);
    assert.equal(fixture.createInputs[0]?.visitorCount, 0);
    assert.equal(fixture.createInputs[0]?.coverObjectKey, null);
    assert.match(fixture.createInputs[0]?.idempotencyKeyHash ?? '', /^[0-9a-f]{64}$/);
    assert.match(fixture.createInputs[0]?.requestHash ?? '', /^[0-9a-f]{64}$/);

    const replay = await createOffice(fixture, 'create-office-key');
    assert.equal(replay.status, 201);
    assert.equal((await replay.json() as { office: { id: string } }).office.id,
        createdBody.office?.id);
    const conflict = await createOffice(
        fixture,
        'create-office-key',
        officeBody({ name: 'Different office' })
    );
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json() as { code: string }).code,
        'FUDABA_IDEMPOTENCY_CONFLICT');

    const forbidden = await createOffice(
        fixture,
        'unknown-field',
        officeBody({ status: 'hidden' })
    );
    assert.equal(forbidden.status, 400);
});

test('metadata and status routes fence stale, hidden, and non-owner writes', async () => {
    const fixture = new OfficeRouteFixture();
    const stale = await fixture.app.request(
        'http://ims.test/api/community/exchange/me/offices/owner-office',
        {
            method: 'PUT',
            headers: bearerHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify({ ...officeBody(), expectedRevision: 9 })
        }
    );
    assert.equal(stale.status, 409);
    assert.equal((await stale.json() as { revision: number }).revision, 0);
    assert.equal((await fixture.app.request(
        'http://ims.test/api/community/exchange/me/offices/other-office',
        {
            method: 'DELETE',
            headers: bearerHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify({ expectedRevision: 0 })
        }
    )).status, 404);

    const hidden = fixture.offices.get('owner-office')!;
    hidden.status = 'hidden';
    const hiddenMetadata = await fixture.app.request(
        'http://ims.test/api/community/exchange/me/offices/owner-office',
        {
            method: 'PUT',
            headers: bearerHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify({ ...officeBody(), expectedRevision: 0 })
        }
    );
    assert.equal(hiddenMetadata.status, 409);
    assert.equal(
        (await hiddenMetadata.json() as { code: string }).code,
        'FUDABA_OFFICE_STATE_CONFLICT'
    );
    for (const [method, suffix] of [
        ['DELETE', ''],
        ['POST', '/restore']
    ] as const) {
        const response = await fixture.app.request(
            `http://ims.test/api/community/exchange/me/offices/owner-office${suffix}`,
            {
                method,
                headers: bearerHeaders({ 'content-type': 'application/json' }),
                body: JSON.stringify({ expectedRevision: 0 })
            }
        );
        assert.equal(response.status, 409);
        assert.equal((await response.json() as { officeStatus: string }).officeStatus,
            'hidden');
    }
});

test('cover upload is active-only, reserves before put, and serves private previews', async () => {
    for (const status of ['hidden', 'archived'] as const) {
        const rejected = new OfficeRouteFixture();
        rejected.offices.get('owner-office')!.status = status;
        const response = await uploadCover(rejected);
        assert.equal(response.status, 409, status);
        assert.equal(rejected.uploads.calls.length, 0, status);
        assert.equal(rejected.storage.puts.length, 0, status);
    }
    const pending = new OfficeRouteFixture();
    pending.offices.get('owner-office')!.pending_cover_object_key = 'already-pending';
    assert.equal((await uploadCover(pending)).status, 409);
    assert.equal(pending.uploads.calls.length, 0);

    const fixture = new OfficeRouteFixture();
    const uploaded = await uploadCover(fixture);
    const body = await uploaded.json();
    assert.equal(uploaded.status, 202, JSON.stringify(body));
    assert.deepEqual(fixture.events.slice(0, 2), ['reserve', 'put']);
    assert.deepEqual(fixture.uploads.calls[0], {
        maxBytes: (8 * 1024 * 1024) + (64 * 1024),
        fileFields: ['image'],
        maxFiles: 1,
        maxFields: 1,
        maxParts: 2
    });
    const put = fixture.storage.puts[0]!;
    assert.match(put.key, /^community\/fudaba\/offices\/owner-office\/covers\/.+\.webp$/);
    assert.equal(put.options.contentType, 'image/webp');
    assert.equal(put.options.protectedAccess, true);
    assert.match(put.options.ownerToken ?? '', /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(body).includes(put.key), false);
    assert.equal(JSON.stringify(body).includes('object_key'), false);

    const preview = await fixture.app.request(
        'http://ims.test/api/community/exchange/me/offices/owner-office/media/pending-cover',
        { headers: bearerHeaders(), redirect: 'manual' }
    );
    assert.equal(preview.status, 307);
    assert.equal(preview.headers.get('cache-control'), 'private, no-store');
    const head = await fixture.app.request(
        'http://ims.test/api/community/exchange/me/offices/owner-office/media/pending-cover',
        { method: 'HEAD', headers: bearerHeaders(), redirect: 'manual' }
    );
    assert.equal(head.status, 307);
    assert.equal(fixture.storage.reads.at(-1)?.method, 'HEAD');

    const withdrawn = await fixture.app.request(
        'http://ims.test/api/community/exchange/me/offices/owner-office/cover/pending',
        {
            method: 'DELETE',
            headers: bearerHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify({ expectedRevision: 1 })
        }
    );
    assert.equal(withdrawn.status, 200);
    assert.equal(fixture.offices.get('owner-office')?.pending_cover_object_key, null);
    assert.equal(fixture.storage.objects.has(put.key), false);
});

test('cover failures release the reservation and uncertain commits reconcile', async () => {
    const failed = new OfficeRouteFixture();
    failed.storage.failPut = true;
    const response = await uploadCover(failed);
    assert.equal(response.status, 500);
    assert.deepEqual(failed.events.slice(0, 4), [
        'reserve', 'put', 'release', 'owned-delete'
    ]);
    assert.equal(failed.offices.get('owner-office')?.pending_cover_object_key, null);
    assert.equal(failed.storage.ownedDeletes.length, 1);

    const uncertain = new OfficeRouteFixture();
    uncertain.reserveMode = 'mutate-then-throw';
    const recovered = await uploadCover(uncertain);
    assert.equal(recovered.status, 202);
    assert.deepEqual(uncertain.events.slice(0, 2), ['reserve', 'put']);
    assert.equal(uncertain.storage.ownedDeletes.length, 0);
});

test('cover cleanup preserves objects while the database still or possibly references them',
    async () => {
        for (const clearMode of ['unavailable', 'throw'] as const) {
            const unknown = new OfficeRouteFixture();
            unknown.storage.failPutAfterStore = true;
            unknown.clearMode = clearMode;
            unknown.failOwnerReadAfterPut = true;
            const response = await uploadCover(unknown);
            const objectKey = unknown.storage.puts[0]!.key;
            assert.equal(response.status, 500, clearMode);
            assert.equal(unknown.clearAttempts, 3, clearMode);
            assert.equal(
                unknown.offices.get('owner-office')?.pending_cover_object_key,
                objectKey,
                clearMode
            );
            assert.equal(unknown.storage.objects.has(objectKey), true, clearMode);
            assert.equal(unknown.storage.ownedDeletes.length, 0, clearMode);
        }

        const promoted = new OfficeRouteFixture();
        promoted.storage.failPutAfterStore = true;
        promoted.clearMode = 'promote';
        const response = await uploadCover(promoted);
        const objectKey = promoted.storage.puts[0]!.key;
        assert.equal(response.status, 500);
        assert.equal(
            promoted.offices.get('owner-office')?.cover_object_key,
            objectKey
        );
        assert.equal(
            promoted.offices.get('owner-office')?.pending_cover_object_key,
            null
        );
        assert.equal(promoted.storage.objects.has(objectKey), true);
        assert.equal(promoted.storage.ownedDeletes.length, 0);
    });

test('cover upload reconciles withdrawal and unknown reads after object storage succeeds',
    async () => {
        const withdrawn = new OfficeRouteFixture();
        withdrawn.storage.afterPut = () => {
            const office = withdrawn.offices.get('owner-office')!;
            office.pending_cover_object_key = null;
            office.pending_cover_submitted_at = null;
            office.revision += 1;
        };
        const conflict = await uploadCover(withdrawn);
        const withdrawnKey = withdrawn.storage.puts[0]!.key;
        assert.equal(conflict.status, 409);
        assert.equal((await conflict.json() as { code: string }).code,
            'FUDABA_OFFICE_CONFLICT');
        assert.equal(withdrawn.storage.objects.has(withdrawnKey), false);
        assert.equal(withdrawn.storage.ownedDeletes.length, 1);

        const unknown = new OfficeRouteFixture();
        unknown.failOwnerReadAfterPut = true;
        const failed = await uploadCover(unknown);
        const unknownKey = unknown.storage.puts[0]!.key;
        assert.equal(failed.status, 500);
        assert.equal(
            unknown.offices.get('owner-office')?.pending_cover_object_key,
            unknownKey
        );
        assert.equal(unknown.storage.objects.has(unknownKey), true);
        assert.equal(unknown.storage.ownedDeletes.length, 0);
    });

test('cover upload consumes IP and account limits before multipart parsing', async () => {
    for (const bucket of ['fudaba-upload-attempt', 'platform-upload-account']) {
        const fixture = new OfficeRouteFixture();
        fixture.rateLimiter.deniedBuckets.add(bucket);
        const response = await uploadCover(fixture);
        assert.equal(response.status, 429, bucket);
        assert.equal(fixture.uploads.calls.length, 0, bucket);
        assert.equal(fixture.storage.puts.length, 0, bucket);
    }
    const successful = new OfficeRouteFixture();
    assert.equal((await uploadCover(successful)).status, 202);
    for (const bucket of [
        'fudaba-upload-attempt',
        'platform-upload-account',
        'platform-write-account'
    ]) {
        assert.equal(successful.rateLimiter.calls.includes(bucket), true, bucket);
    }
});
