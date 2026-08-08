import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createHonoApp } from '@/app';
import {
    PLATFORM_ACCESS_TOKEN_COOKIE,
    PLATFORM_CSRF_TOKEN_COOKIE
} from '@/domains/platform-auth/platform-auth-session';
import type { RateLimiter } from '@/ports/cache';
import type {
    ParsedUpload,
    UploadParser,
    UploadedFile
} from '@/ports/http';
import type { ImageInfo, ImageProcessor } from '@/ports/media';
import type {
    CompensationService,
    ListedObject,
    ObjectReadTarget,
    ObjectReadUrlOptions,
    ObjectStorage,
    PutObjectOptions,
    StoredObject
} from '@/ports/object-storage';
import type {
    CreateOwnedFudabaCardInput,
    FudabaCardMutationResult,
    FudabaCardRecord,
    FudabaRepository,
    PlatformAccountRepository,
    PlatformAccountStatus,
    PlatformProfileRecord,
    SoftDeleteOwnedFudabaCardInput,
    UpdateOwnedFudabaCardMediaInput,
    UpdateOwnedFudabaCardMetadataInput,
    UpdatePlatformProfileAvatarInput,
    UpdatePlatformProfileTextInput
} from '@/ports/repositories';
import type { RuntimeServices } from '@/ports/runtime-services';

const ACCOUNT_ID = 'platform-owner';
const OTHER_ACCOUNT_ID = 'platform-other';
const PLATFORM_TOKEN = 'valid-platform-token';
const BACKOFFICE_TOKEN = 'valid-backoffice-token';
const CSRF_SECRET = 'owner-csrf-secret';
const CREATED_AT = '2026-08-02T00:00:00.000Z';
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0x01]);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function csrfHash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function uploadedFile(
    filename: string,
    contentType: string,
    body: Uint8Array
): UploadedFile {
    return { filename, contentType, body };
}

function ownerCard(overrides: Partial<FudabaCardRecord> = {}): FudabaCardRecord {
    return {
        id: 'owner-card',
        owner_account_id: ACCOUNT_ID,
        producer_name: 'Owner Producer',
        display_name: 'Owner Card',
        series_code: '765',
        favorite_idol: 'Haruka',
        front_object_key: 'protected/fudaba/cards/owner-card/front.webp',
        back_object_key: 'protected/fudaba/cards/owner-card/back.webp',
        accent: '#4f64dd',
        bio: 'Owner bio',
        trade_note: 'Owner trade note',
        available: true,
        source_url: null,
        source_label: null,
        source_credit: null,
        media_rights_status: 'unknown',
        publication_status: 'pending',
        revision: 1,
        created_at: CREATED_AT,
        updated_at: CREATED_AT,
        deleted_at: null,
        ...overrides
    };
}

function cardFields(): Record<string, string> {
    return {
        producerName: 'New Producer',
        displayName: 'New Card',
        seriesCode: '765',
        favoriteIdol: 'Chihaya',
        accent: '#336699',
        bio: 'New bio',
        tradeNote: 'New trade note',
        available: 'true'
    };
}

function cardUpload(
    front: UploadedFile = uploadedFile('front.jpg', 'image/jpeg', JPEG_BYTES),
    back: UploadedFile = uploadedFile('back.png', 'image/png', PNG_BYTES)
): ParsedUpload {
    return {
        fields: cardFields(),
        files: { front, back }
    };
}

function mediaUpload(
    fields: Record<string, string>,
    file: UploadedFile = uploadedFile('image.jpg', 'image/jpeg', JPEG_BYTES)
): ParsedUpload {
    return { fields, files: { image: file } };
}

class ControlledUploadParser implements UploadParser {
    next: ParsedUpload = cardUpload();
    readonly calls: Array<Parameters<UploadParser['parse']>[1]> = [];

    async parse(
        _request: Request,
        options: Parameters<UploadParser['parse']>[1]
    ): Promise<ParsedUpload> {
        this.calls.push(options);
        return this.next;
    }
}

class SniffingImageProcessor implements ImageProcessor {
    readonly validations: Array<{ body: Uint8Array; declaredType?: string }> = [];
    readonly conversions: Uint8Array[] = [];

    async validate(body: Uint8Array, declaredType?: string): Promise<ImageInfo> {
        this.validations.push({ body, declaredType });
        if (body[0] === 0xff) {
            return {
                format: 'jpeg',
                width: 1200,
                height: 800,
                contentType: 'image/jpeg'
            };
        }
        if (body[0] === 0x89) {
            return {
                format: 'png',
                width: 800,
                height: 1200,
                contentType: 'image/png'
            };
        }
        if (body[0] === 0x52) {
            return {
                format: 'webp',
                width: 1000,
                height: 1000,
                contentType: 'image/webp'
            };
        }
        throw new Error('undecodable image');
    }

    async toWebp(body: Uint8Array): Promise<Uint8Array> {
        this.conversions.push(body);
        return new Uint8Array([0x52, 0x49, 0x46, 0x46, body[0] ?? 0]);
    }

    async thumbnailPng(): Promise<Uint8Array> {
        throw new Error('unused');
    }

    async resizeJpeg(): Promise<Uint8Array> {
        throw new Error('unused');
    }
}

interface MemoryObject {
    stored: StoredObject;
    options: PutObjectOptions;
}

class ProtectedMemoryStorage implements ObjectStorage {
    readonly objects = new Map<string, MemoryObject>();
    readonly puts: Array<{
        key: string;
        body: Uint8Array;
        options: PutObjectOptions;
    }> = [];
    readonly deletes: string[] = [];
    readonly ownedDeletes: Array<{ key: string; ownerToken: string }> = [];
    readonly readUrls: Array<{ key: string; method?: 'GET' | 'HEAD' }> = [];
    readonly failDeletes = new Set<string>();
    failPutNumber: number | null = null;

    seed(key: string, body = new Uint8Array([0x52, 0x49, 0x46, 0x46])): void {
        this.objects.set(key, {
            stored: {
                body,
                size: body.byteLength,
                contentType: 'image/webp',
                etag: `seed-${key}`
            },
            options: { contentType: 'image/webp', protectedAccess: true }
        });
    }

    async get(key: string): Promise<StoredObject | null> {
        return this.objects.get(key)?.stored ?? null;
    }

    async createReadUrl(
        key: string,
        options?: ObjectReadUrlOptions
    ): Promise<ObjectReadTarget | null> {
        this.readUrls.push({ key, method: options?.method });
        return this.objects.has(key)
            ? {
                url: `https://private-media.example.test/${encodeURIComponent(key)}?signed=1`,
                visibility: 'private'
            }
            : null;
    }

    async put(
        key: string,
        body: Uint8Array,
        options: PutObjectOptions = {}
    ): Promise<StoredObject> {
        this.puts.push({ key, body, options });
        if (this.failPutNumber === this.puts.length) {
            throw new Error('object write failed');
        }
        const stored = {
            body,
            size: body.byteLength,
            contentType: options.contentType || 'application/octet-stream',
            etag: `etag-${this.puts.length}`
        };
        this.objects.set(key, { stored, options });
        return stored;
    }

    async delete(key: string): Promise<void> {
        this.deletes.push(key);
        if (this.failDeletes.has(key)) throw new Error('object delete failed');
        this.objects.delete(key);
    }

    async deleteIfOwned(key: string, ownerToken: string): Promise<boolean> {
        this.ownedDeletes.push({ key, ownerToken });
        const object = this.objects.get(key);
        if (!object || object.options.ownerToken !== ownerToken) return false;
        this.objects.delete(key);
        return true;
    }

    async exists(key: string): Promise<boolean> {
        return this.objects.has(key);
    }

    async copy(sourceKey: string, destinationKey: string): Promise<void> {
        const object = this.objects.get(sourceKey);
        if (!object) throw new Error('missing source');
        this.objects.set(destinationKey, object);
    }

    async move(sourceKey: string, destinationKey: string): Promise<void> {
        await this.copy(sourceKey, destinationKey);
        await this.delete(sourceKey);
    }

    async list(prefix: string): Promise<ListedObject[]> {
        return [...this.objects.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, value]) => ({
                key,
                size: value.stored.size,
                etag: value.stored.etag
            }));
    }

    async deletePrefix(prefix: string): Promise<void> {
        for (const key of [...this.objects.keys()]) {
            if (key.startsWith(prefix)) this.objects.delete(key);
        }
    }
}

class RecordingCompensation implements CompensationService {
    readonly enqueued: Array<{ kind: string; payload: unknown; error?: unknown }> = [];

    async enqueue(kind: string, payload: unknown, error?: unknown): Promise<string> {
        this.enqueued.push({ kind, payload, error });
        return `compensation-${this.enqueued.length}`;
    }

    async run(): Promise<void> {}
}

class ControlledRateLimiter implements RateLimiter {
    readonly deniedBuckets = new Set<string>();
    readonly calls: Array<{ bucket: string; key: string; limit: number }> = [];

    async consume(
        bucket: string,
        key: string,
        limit: number
    ): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
        this.calls.push({ bucket, key, limit });
        const allowed = !this.deniedBuckets.has(bucket);
        return {
            allowed,
            remaining: allowed ? Math.max(0, limit - 1) : 0,
            resetAt: Date.now() + 60_000
        };
    }
}

interface FixtureOptions {
    accountStatus?: PlatformAccountStatus;
    publicReadEnabled?: boolean;
    writeEnabled?: boolean;
}

class OwnerRouteFixture {
    accountStatus: PlatformAccountStatus;
    publicReadEnabled: boolean;
    writeEnabled: boolean;
    profile: PlatformProfileRecord = {
        account_id: ACCOUNT_ID,
        display_name: 'Owner Display',
        avatar_object_key: null,
        avatar_external_url: null,
        home_city: 'Shanghai',
        bio: 'Profile bio',
        updated_at: 1_000
    };
    readonly session = {
        id: 'platform-session',
        account_id: ACCOUNT_ID,
        token_hash: 'refresh-hash',
        previous_token_hash: null,
        csrf_hash: csrfHash(CSRF_SECRET),
        expires_at: Date.now() + 60 * 60 * 1000,
        created_at: Date.now(),
        updated_at: Date.now(),
        revoked_at: null as number | null
    };
    readonly cards = new Map<string, FudabaCardRecord>();
    readonly uploads = new ControlledUploadParser();
    readonly images = new SniffingImageProcessor();
    readonly storage = new ProtectedMemoryStorage();
    readonly compensation = new RecordingCompensation();
    readonly rateLimiter = new ControlledRateLimiter();
    createMode: 'saved' | 'unavailable' | 'throw' | 'mutate-then-throw' = 'saved';
    updateAvatarMode: 'saved' | 'mutate-then-throw' = 'saved';
    updateMediaMode:
        | 'saved'
        | 'unavailable'
        | 'conflict'
        | 'throw'
        | 'mutate-then-throw' = 'saved';
    failCardConfirmationRead = false;
    failProfileConfirmationRead = false;
    private cardMutationCommitted = false;
    private profileMutationCommitted = false;
    readonly createInputs: CreateOwnedFudabaCardInput[] = [];
    readonly metadataInputs: UpdateOwnedFudabaCardMetadataInput[] = [];
    readonly mediaInputs: UpdateOwnedFudabaCardMediaInput[] = [];
    readonly deleteInputs: SoftDeleteOwnedFudabaCardInput[] = [];
    readonly profileTextInputs: UpdatePlatformProfileTextInput[] = [];
    readonly profileAvatarInputs: UpdatePlatformProfileAvatarInput[] = [];
    readonly app: ReturnType<typeof createHonoApp>;

    constructor(options: FixtureOptions = {}) {
        this.accountStatus = options.accountStatus ?? 'active';
        this.publicReadEnabled = options.publicReadEnabled ?? true;
        this.writeEnabled = options.writeEnabled ?? true;
        const card = ownerCard();
        const other = ownerCard({
            id: 'other-card',
            owner_account_id: OTHER_ACCOUNT_ID,
            front_object_key: 'protected/fudaba/cards/other-card/front.webp',
            back_object_key: 'protected/fudaba/cards/other-card/back.webp'
        });
        this.cards.set(card.id, card);
        this.cards.set(other.id, other);
        this.storage.seed(card.front_object_key);
        this.storage.seed(card.back_object_key);
        this.storage.seed(other.front_object_key);
        this.storage.seed(other.back_object_key);
        this.app = createHonoApp(() => this.runtime());
    }

    private identity() {
        return {
            account: {
                id: ACCOUNT_ID,
                status: this.accountStatus,
                token_version: 0,
                created_at: 500,
                updated_at: 500,
                deleted_at: this.accountStatus === 'deleted' ? 500 : null
            },
            profile: { ...this.profile }
        };
    }

    readonly platformAccounts = {
        findRefreshSessionById: async (id: string) =>
            id === this.session.id ? { ...this.session } : null,
        findAccountWithProfileById: async (id: string) => {
            if (this.profileMutationCommitted && this.failProfileConfirmationRead) {
                throw new Error('profile confirmation read failed');
            }
            return id === ACCOUNT_ID ? this.identity() : null;
        },
        updateProfileTextForOwner: async (input: UpdatePlatformProfileTextInput) => {
            this.profileTextInputs.push(input);
            if (this.accountStatus !== 'active') return { status: 'unavailable' as const };
            if (input.expectedUpdatedAt !== this.profile.updated_at) {
                return {
                    status: 'conflict' as const,
                    updatedAt: this.profile.updated_at
                };
            }
            this.profile = {
                ...this.profile,
                display_name: input.displayName,
                home_city: input.homeCity,
                bio: input.bio,
                updated_at: input.updatedAt
            };
            return {
                status: 'saved' as const,
                profile: { ...this.profile },
                previousAvatarObjectKey: this.profile.avatar_object_key
            };
        },
        updateProfileAvatarForOwner: async (input: UpdatePlatformProfileAvatarInput) => {
            this.profileAvatarInputs.push(input);
            if (this.accountStatus !== 'active') return { status: 'unavailable' as const };
            if (input.expectedUpdatedAt !== this.profile.updated_at) {
                return {
                    status: 'conflict' as const,
                    updatedAt: this.profile.updated_at
                };
            }
            const previousAvatarObjectKey = this.profile.avatar_object_key;
            this.profile = {
                ...this.profile,
                avatar_object_key: input.avatarObjectKey,
                avatar_external_url: null,
                updated_at: input.updatedAt
            };
            if (this.updateAvatarMode === 'mutate-then-throw') {
                this.profileMutationCommitted = true;
                throw new Error('profile connection lost after commit');
            }
            return {
                status: 'saved' as const,
                profile: { ...this.profile },
                previousAvatarObjectKey
            };
        },
        revokeRefreshSession: async () => true
    } as unknown as PlatformAccountRepository;

    readonly fudaba = {
        listPublicSeries: async () => [{
            id: 1,
            code: '765',
            display_name: '765PRO',
            color: '#f34f6d',
            display_order: 0,
            icon_object_key: null,
            image_transform: {
                fit: 'contain' as const,
                focalX: 0.5,
                focalY: 0.5,
                zoom: 1,
                rotation: 0 as const
            },
            active_office_count: 0
        }],
        listPublicOffices: async () => [],
        findPublicOfficeBySlug: async () => null,
        listPublicCards: async () => [],
        listCardsForOwner: async (ownerAccountId: string) =>
            [...this.cards.values()].filter((card) =>
                card.owner_account_id === ownerAccountId && card.deleted_at === null
            ),
        findCardForOwner: async (cardId: string, ownerAccountId: string) => {
            if (this.cardMutationCommitted && this.failCardConfirmationRead) {
                throw new Error('card confirmation read failed');
            }
            const card = this.cards.get(cardId);
            return card?.owner_account_id === ownerAccountId && card.deleted_at === null
                ? { ...card }
                : null;
        },
        createCardForOwner: async (
            input: CreateOwnedFudabaCardInput
        ): Promise<FudabaCardMutationResult> => {
            this.createInputs.push(input);
            if (this.createMode === 'throw') throw new Error('repository write failed');
            if (this.createMode === 'unavailable') return { status: 'unavailable' };
            const card = ownerCard({
                id: input.id,
                owner_account_id: input.ownerAccountId,
                producer_name: input.producerName,
                display_name: input.displayName,
                series_code: input.seriesCode,
                favorite_idol: input.favoriteIdol,
                front_object_key: input.frontObjectKey,
                back_object_key: input.backObjectKey,
                accent: input.accent,
                bio: input.bio,
                trade_note: input.tradeNote,
                available: input.available,
                revision: 0,
                created_at: input.createdAt,
                updated_at: input.updatedAt
            });
            this.cards.set(card.id, card);
            if (this.createMode === 'mutate-then-throw') {
                this.cardMutationCommitted = true;
                throw new Error('card connection lost after commit');
            }
            return { status: 'saved', card: { ...card }, previousObjectKey: null };
        },
        updateCardMetadataForOwner: async (
            input: UpdateOwnedFudabaCardMetadataInput
        ): Promise<FudabaCardMutationResult> => {
            this.metadataInputs.push(input);
            const current = this.cards.get(input.cardId);
            if (
                !current || current.owner_account_id !== input.ownerAccountId ||
                current.deleted_at !== null || this.accountStatus !== 'active'
            ) {
                return { status: 'unavailable' };
            }
            if (current.revision !== input.expectedRevision) {
                return { status: 'conflict', revision: current.revision };
            }
            const card = {
                ...current,
                producer_name: input.producerName,
                display_name: input.displayName,
                series_code: input.seriesCode,
                favorite_idol: input.favoriteIdol,
                accent: input.accent,
                bio: input.bio,
                trade_note: input.tradeNote,
                available: input.available,
                media_rights_status: 'unknown' as const,
                publication_status: 'pending' as const,
                revision: current.revision + 1,
                updated_at: input.updatedAt
            };
            this.cards.set(card.id, card);
            return { status: 'saved', card: { ...card }, previousObjectKey: null };
        },
        updateCardMediaForOwner: async (
            input: UpdateOwnedFudabaCardMediaInput
        ): Promise<FudabaCardMutationResult> => {
            this.mediaInputs.push(input);
            if (this.updateMediaMode === 'throw') throw new Error('media repository failed');
            const current = this.cards.get(input.cardId);
            if (
                this.updateMediaMode === 'unavailable' || !current ||
                current.owner_account_id !== input.ownerAccountId ||
                current.deleted_at !== null || this.accountStatus !== 'active'
            ) {
                return { status: 'unavailable' };
            }
            if (
                this.updateMediaMode === 'conflict' ||
                current.revision !== input.expectedRevision
            ) {
                return { status: 'conflict', revision: current.revision };
            }
            const property = input.side === 'front'
                ? 'front_object_key' as const
                : 'back_object_key' as const;
            const previousObjectKey = current[property];
            const card = {
                ...current,
                [property]: input.objectKey,
                media_rights_status: 'unknown' as const,
                publication_status: 'pending' as const,
                revision: current.revision + 1,
                updated_at: input.updatedAt
            };
            this.cards.set(card.id, card);
            if (this.updateMediaMode === 'mutate-then-throw') {
                this.cardMutationCommitted = true;
                throw new Error('media connection lost after commit');
            }
            return { status: 'saved', card: { ...card }, previousObjectKey };
        },
        softDeleteCardForOwner: async (
            input: SoftDeleteOwnedFudabaCardInput
        ): Promise<FudabaCardMutationResult> => {
            this.deleteInputs.push(input);
            const current = this.cards.get(input.cardId);
            if (
                !current || current.owner_account_id !== input.ownerAccountId ||
                current.deleted_at !== null || this.accountStatus !== 'active'
            ) {
                return { status: 'unavailable' };
            }
            if (current.revision !== input.expectedRevision) {
                return { status: 'conflict', revision: current.revision };
            }
            const card = {
                ...current,
                revision: current.revision + 1,
                deleted_at: input.deletedAt,
                updated_at: input.deletedAt
            };
            this.cards.set(card.id, card);
            return { status: 'saved', card: { ...card }, previousObjectKey: null };
        }
    } as unknown as FudabaRepository;

    runtime(): RuntimeServices {
        return {
            fudaba: this.fudaba,
            platformAccounts: this.platformAccounts,
            uploads: this.uploads,
            images: this.images,
            storage: this.storage,
            compensation: this.compensation,
            rateLimiter: this.rateLimiter,
            platformTokens: {
                async sign() { return PLATFORM_TOKEN; },
                async verify(token: string) {
                    if (token !== PLATFORM_TOKEN) throw new Error('wrong token realm');
                    const now = Math.floor(Date.now() / 1000);
                    return {
                        iss: 'imsweb' as const,
                        aud: 'ims-platform' as const,
                        kind: 'platform' as const,
                        id: ACCOUNT_ID,
                        tokenVersion: 0,
                        sessionId: 'platform-session',
                        csrfSecret: CSRF_SECRET,
                        jti: 'platform-access',
                        iat: now,
                        exp: now + 900
                    };
                }
            },
            backofficeTokens: {
                async sign() { return BACKOFFICE_TOKEN; },
                async verify(token: string) {
                    if (token !== BACKOFFICE_TOKEN) throw new Error('invalid');
                    return {
                        iss: 'imsweb' as const,
                        aud: 'ims-backoffice' as const,
                        kind: 'backoffice' as const,
                        id: 1,
                        username: 'admin',
                        producername: 'Admin',
                        dept: 'op',
                        csrfSecret: 'admin-csrf'
                    };
                }
            },
            config: {
                fudabaPublicReadEnabled: this.publicReadEnabled,
                fudabaWriteEnabled: this.writeEnabled
            }
        };
    }
}

function bearerHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${PLATFORM_TOKEN}`, ...extra };
}

function cookieHeaders(
    csrfHeader: string | null = CSRF_SECRET,
    csrfCookie = CSRF_SECRET
): Record<string, string> {
    return {
        cookie: `${PLATFORM_ACCESS_TOKEN_COOKIE}=${PLATFORM_TOKEN}; ` +
            `${PLATFORM_CSRF_TOKEN_COOKIE}=${csrfCookie}`,
        ...(csrfHeader === null ? {} : { 'x-csrftoken': csrfHeader })
    };
}

function profileBody(expectedUpdatedAt: number): Record<string, unknown> {
    return {
        displayName: 'Updated Owner',
        homeCity: 'Beijing',
        bio: 'Updated profile bio',
        expectedUpdatedAt
    };
}

function metadataBody(expectedRevision: number): Record<string, unknown> {
    return {
        producerName: 'Updated Producer',
        displayName: 'Updated Card',
        seriesCode: '765',
        favoriteIdol: 'Miki',
        accent: '#112233',
        bio: 'Updated card bio',
        tradeNote: 'Updated card trade note',
        available: false,
        expectedRevision
    };
}

async function postCard(fixture: OwnerRouteFixture): Promise<Response> {
    return fixture.app.request('http://ims.test/api/community/exchange/cards', {
        method: 'POST',
        headers: bearerHeaders(),
        body: new FormData()
    });
}

test('Fudaba public-read and owner-write flags remain independent', async () => {
    const readOnly = new OwnerRouteFixture({
        publicReadEnabled: true,
        writeEnabled: false
    });
    assert.equal((await readOnly.app.request(
        'http://ims.test/api/community/exchange/series'
    )).status, 200);
    assert.equal((await postCard(readOnly)).status, 404);
    assert.equal(readOnly.uploads.calls.length, 0);
    assert.equal((await readOnly.app.request(
        'http://ims.test/api/community/exchange/me/cards',
        { headers: bearerHeaders() }
    )).status, 200, 'owner reads do not depend on either rollout switch');
    assert.equal((await readOnly.app.request(
        'http://ims.test/api/community/exchange/me/series',
        { headers: bearerHeaders() }
    )).status, 200, 'owner series do not depend on either rollout switch');
    const readOnlyProfile = await readOnly.app.request(
        'http://ims.test/api/platform/me',
        { headers: bearerHeaders() }
    );
    assert.equal(readOnlyProfile.status, 200);
    assert.equal((await readOnlyProfile.json() as {
        capabilities: { fudabaWrite: boolean };
    }).capabilities.fudabaWrite, false);

    const writeOnly = new OwnerRouteFixture({
        publicReadEnabled: false,
        writeEnabled: true
    });
    assert.equal((await writeOnly.app.request(
        'http://ims.test/api/community/exchange/series'
    )).status, 404);
    const ownerSeries = await writeOnly.app.request(
        'http://ims.test/api/community/exchange/me/series',
        { headers: bearerHeaders() }
    );
    assert.equal(ownerSeries.status, 200);
    assert.deepEqual(await ownerSeries.json(), {
        items: [{
            id: 1,
            code: '765',
            displayName: '765PRO',
            displayOrder: 0,
            color: '#f34f6d',
            iconUrl: null,
            imageTransform: {
                fit: 'contain',
                focalX: 0.5,
                focalY: 0.5,
                zoom: 1,
                rotation: 0
            },
            activeOfficeCount: 0
        }]
    });
    const cookieOwnerSeries = await writeOnly.app.request(
        'http://ims.test/api/community/exchange/me/series',
        { headers: cookieHeaders(null) }
    );
    assert.equal(cookieOwnerSeries.status, 200);
    assert.equal(cookieOwnerSeries.headers.get('cache-control'),
        'private, no-store');
    assert.match(cookieOwnerSeries.headers.get('vary') || '', /Authorization/);
    assert.match(cookieOwnerSeries.headers.get('vary') || '', /Cookie/);
    assert.equal((await postCard(writeOnly)).status, 201);
});

test('owner routes require Platform auth and reject Backoffice tokens', async () => {
    const fixture = new OwnerRouteFixture();
    const anonymous = await fixture.app.request(
        'http://ims.test/api/community/exchange/me/cards'
    );
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json() as { code: string }).code,
        'PLATFORM_SESSION_INVALID');

    const wrongRealm = await fixture.app.request(
        'http://ims.test/api/community/exchange/me/cards',
        { headers: { authorization: `Bearer ${BACKOFFICE_TOKEN}` } }
    );
    assert.equal(wrongRealm.status, 401);
    assert.equal((await wrongRealm.json() as { code: string }).code,
        'PLATFORM_SESSION_INVALID');

    assert.equal((await fixture.app.request(
        'http://ims.test/api/community/exchange/me/series'
    )).status, 401);
    assert.equal((await fixture.app.request(
        'http://ims.test/api/community/exchange/me/series',
        { headers: { authorization: `Bearer ${BACKOFFICE_TOKEN}` } }
    )).status, 401);
});

test('cookie writes require the full CSRF triad while Bearer writes bypass CSRF', async () => {
    const fixture = new OwnerRouteFixture();
    for (const headers of [
        cookieHeaders(null),
        cookieHeaders('different-secret'),
        cookieHeaders(CSRF_SECRET, 'different-secret')
    ]) {
        const response = await fixture.app.request('http://ims.test/api/platform/me', {
            method: 'PUT',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify(profileBody(fixture.profile.updated_at))
        });
        assert.equal(response.status, 403);
        assert.equal((await response.json() as { code: string }).code,
            'PLATFORM_CSRF_INVALID');
    }
    fixture.session.csrf_hash = csrfHash('different-secret');
    const badStoredHash = await fixture.app.request('http://ims.test/api/platform/me', {
        method: 'PUT',
        headers: { ...cookieHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify(profileBody(fixture.profile.updated_at))
    });
    assert.equal(badStoredHash.status, 403);
    fixture.session.csrf_hash = csrfHash(CSRF_SECRET);

    const cookieWrite = await fixture.app.request('http://ims.test/api/platform/me', {
        method: 'PUT',
        headers: { ...cookieHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify(profileBody(fixture.profile.updated_at))
    });
    assert.equal(cookieWrite.status, 200);

    const bearerWrite = await fixture.app.request('http://ims.test/api/platform/me', {
        method: 'PUT',
        headers: bearerHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify(profileBody(fixture.profile.updated_at))
    });
    assert.equal(bearerWrite.status, 200);
});

test('restricted Platform accounts retain owner reads but cannot mutate or parse uploads', async () => {
    const fixture = new OwnerRouteFixture({ accountStatus: 'restricted' });
    assert.equal((await fixture.app.request('http://ims.test/api/platform/me', {
        headers: bearerHeaders()
    })).status, 200);
    assert.equal((await fixture.app.request(
        'http://ims.test/api/community/exchange/me/cards',
        { headers: bearerHeaders() }
    )).status, 200);
    assert.equal((await fixture.app.request(
        'http://ims.test/api/community/exchange/me/series',
        { headers: bearerHeaders() }
    )).status, 200);
    const mutation = await postCard(fixture);
    assert.equal(mutation.status, 403);
    assert.equal((await mutation.json() as { code: string }).code,
        'PLATFORM_ACCOUNT_RESTRICTED');
    assert.equal(fixture.uploads.calls.length, 0);
    assert.equal(fixture.storage.puts.length, 0);
});

test('Platform profile GET and text update expose a fenced owner projection', async () => {
    const fixture = new OwnerRouteFixture();
    fixture.profile.avatar_object_key = 'protected/platform/avatar.webp';
    fixture.storage.seed(fixture.profile.avatar_object_key);
    const get = await fixture.app.request('http://ims.test/api/platform/me', {
        headers: bearerHeaders()
    });
    assert.equal(get.status, 200);
    const initial = await get.json() as {
        account: { id: string; status: string };
        capabilities: { fudabaWrite: boolean };
        profile: { avatarUrl: string; updatedAt: number };
    };
    assert.deepEqual(initial.account, { id: ACCOUNT_ID, status: 'active' });
    assert.equal(initial.capabilities.fudabaWrite, true);
    assert.equal(initial.profile.avatarUrl, '/api/platform/me/avatar?v=1000');
    assert.equal(JSON.stringify(initial).includes('avatar_object_key'), false);

    const expectedUpdatedAt = initial.profile.updatedAt;
    const saved = await fixture.app.request('http://ims.test/api/platform/me', {
        method: 'PUT',
        headers: bearerHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify(profileBody(expectedUpdatedAt))
    });
    assert.equal(saved.status, 200);
    const savedBody = await saved.json() as {
        profile: { displayName: string; updatedAt: number };
    };
    assert.equal(savedBody.profile.displayName, 'Updated Owner');
    assert.ok(savedBody.profile.updatedAt > expectedUpdatedAt);
    assert.equal(fixture.profileTextInputs[0]?.accountId, ACCOUNT_ID);

    const stale = await fixture.app.request('http://ims.test/api/platform/me', {
        method: 'PUT',
        headers: bearerHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify(profileBody(expectedUpdatedAt))
    });
    assert.equal(stale.status, 409);
    assert.deepEqual(await stale.json(), {
        success: false,
        code: 'PLATFORM_PROFILE_CONFLICT',
        updatedAt: savedBody.profile.updatedAt
    });
});

test('owner card list and detail hide non-owner cards and raw object keys', async () => {
    const fixture = new OwnerRouteFixture();
    const list = await fixture.app.request(
        'http://ims.test/api/community/exchange/me/cards',
        { headers: bearerHeaders() }
    );
    assert.equal(list.status, 200);
    const listBody = await list.json() as {
        items: Array<{ id: string; frontImageUrl: string; backImageUrl: string }>;
    };
    assert.equal(listBody.items.length, 1);
    assert.equal(listBody.items[0]?.id, 'owner-card');
    assert.equal(listBody.items[0]?.frontImageUrl,
        '/api/community/exchange/me/cards/owner-card/media/front?v=1');
    assert.equal(JSON.stringify(listBody).includes('object_key'), false);
    assert.equal(JSON.stringify(listBody).includes('protected/fudaba'), false);

    const detail = await fixture.app.request(
        'http://ims.test/api/community/exchange/me/cards/owner-card',
        { headers: bearerHeaders() }
    );
    assert.equal(detail.status, 200);
    assert.equal(JSON.stringify(await detail.json()).includes('object_key'), false);
    assert.equal((await fixture.app.request(
        'http://ims.test/api/community/exchange/me/cards/other-card',
        { headers: bearerHeaders() }
    )).status, 404);
});

test('card creation sniffs both images and writes only protected owner objects', async () => {
    const fixture = new OwnerRouteFixture();
    const response = await postCard(fixture);
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body));
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes('object_key'), false);
    assert.equal(serialized.includes('protected/fudaba'), false);
    assert.equal(fixture.uploads.calls.length, 1);
    assert.deepEqual(fixture.uploads.calls[0]?.fileFields, ['front', 'back']);
    assert.equal(fixture.images.conversions.length, 2);
    assert.equal(fixture.storage.puts.length, 2);
    assert.equal(fixture.createInputs[0]?.ownerAccountId, ACCOUNT_ID);
    for (const put of fixture.storage.puts) {
        assert.equal(put.options.contentType, 'image/webp');
        assert.equal(put.options.protectedAccess, true);
        assert.match(put.options.ownerToken || '', /^[0-9a-f]{64}$/);
        assert.equal(put.options.metadata?.account, ACCOUNT_ID);
        assert.equal(put.options.metadata?.kind, 'fudaba-card-image');
    }
    assert.deepEqual(
        new Set(fixture.storage.puts.map((put) => put.options.metadata?.side)),
        new Set(['front', 'back'])
    );
});

test('card creation rejects decoded image type mismatches before object writes', async () => {
    const fixture = new OwnerRouteFixture();
    fixture.uploads.next = cardUpload(
        uploadedFile('front.png', 'image/png', JPEG_BYTES)
    );
    const response = await postCard(fixture);
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { code: string }).code,
        'FUDABA_CARD_INVALID');
    assert.equal(fixture.storage.puts.length, 0);
    assert.equal(fixture.createInputs.length, 0);
});

test('card metadata writes enforce owner revision fencing', async () => {
    const fixture = new OwnerRouteFixture();
    const stale = await fixture.app.request(
        'http://ims.test/api/community/exchange/me/cards/owner-card',
        {
            method: 'PUT',
            headers: bearerHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify(metadataBody(0))
        }
    );
    assert.equal(stale.status, 409);
    assert.deepEqual(await stale.json(), {
        success: false,
        code: 'FUDABA_CARD_CONFLICT',
        revision: 1
    });
    assert.equal(fixture.metadataInputs[0]?.ownerAccountId, ACCOUNT_ID);

    const intruderTarget = await fixture.app.request(
        'http://ims.test/api/community/exchange/me/cards/other-card',
        {
            method: 'PUT',
            headers: bearerHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify(metadataBody(1))
        }
    );
    assert.equal(intruderTarget.status, 404);
});

test('avatar and both card-side uploads commit through owner CAS without leaking keys', async () => {
    const fixture = new OwnerRouteFixture();
    const oldAvatar = 'protected/platform/old-avatar.webp';
    fixture.profile.avatar_object_key = oldAvatar;
    fixture.storage.seed(oldAvatar);
    fixture.uploads.next = mediaUpload({ expectedUpdatedAt: '1000' });
    const avatar = await fixture.app.request(
        'http://ims.test/api/community/exchange/uploads/avatar',
        { method: 'PUT', headers: bearerHeaders(), body: new FormData() }
    );
    const avatarJson = await avatar.json();
    assert.equal(avatar.status, 200, JSON.stringify(avatarJson));
    assert.equal(JSON.stringify(avatarJson).includes('object_key'), false);
    assert.equal(fixture.profileAvatarInputs[0]?.accountId, ACCOUNT_ID);
    assert.equal(fixture.storage.objects.has(oldAvatar), false);

    let expectedRevision = fixture.cards.get('owner-card')!.revision;
    for (const side of ['front', 'back'] as const) {
        fixture.uploads.next = mediaUpload({
            cardId: 'owner-card',
            expectedRevision: String(expectedRevision)
        });
        const response = await fixture.app.request(
            `http://ims.test/api/community/exchange/uploads/${side}`,
            { method: 'PUT', headers: bearerHeaders(), body: new FormData() }
        );
        const body = await response.json();
        assert.equal(response.status, 200, `${side}: ${JSON.stringify(body)}`);
        assert.equal(JSON.stringify(body).includes('object_key'), false);
        assert.equal(fixture.mediaInputs.at(-1)?.ownerAccountId, ACCOUNT_ID);
        assert.equal(fixture.mediaInputs.at(-1)?.side, side);
        expectedRevision += 1;
    }
    assert.equal(fixture.cards.get('owner-card')?.revision, 3);
    for (const put of fixture.storage.puts) {
        assert.equal(put.options.protectedAccess, true);
        assert.equal(put.options.metadata?.account, ACCOUNT_ID);
    }
});

test('soft deletion fences the owner write and removes protected card media', async () => {
    const fixture = new OwnerRouteFixture();
    const current = fixture.cards.get('owner-card')!;
    const response = await fixture.app.request(
        'http://ims.test/api/community/exchange/me/cards/owner-card',
        {
            method: 'DELETE',
            headers: bearerHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify({ expectedRevision: current.revision })
        }
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, revision: 2 });
    assert.equal(fixture.deleteInputs[0]?.ownerAccountId, ACCOUNT_ID);
    assert.ok(fixture.cards.get('owner-card')?.deleted_at);
    assert.equal(fixture.storage.objects.has(current.front_object_key), false);
    assert.equal(fixture.storage.objects.has(current.back_object_key), false);
    assert.equal((await fixture.app.request(
        'http://ims.test/api/community/exchange/me/cards/owner-card',
        { headers: bearerHeaders() }
    )).status, 404);
});

test('card creation cleans confirmed failures but preserves uncertain repository writes', async () => {
    const unavailable = new OwnerRouteFixture();
    const unavailableSeededKeys = new Set(unavailable.storage.objects.keys());
    unavailable.createMode = 'unavailable';
    const unavailableResponse = await postCard(unavailable);
    assert.equal(unavailableResponse.status, 409);
    assert.equal(unavailable.storage.ownedDeletes.length, 2);
    assert.deepEqual(
        new Set(unavailable.storage.objects.keys()),
        unavailableSeededKeys
    );

    const uncertain = new OwnerRouteFixture();
    uncertain.createMode = 'throw';
    const uncertainResponse = await postCard(uncertain);
    assert.equal(uncertainResponse.status, 500);
    assert.equal(uncertain.storage.ownedDeletes.length, 0);
    for (const put of uncertain.storage.puts) {
        assert.equal(uncertain.storage.objects.has(put.key), true);
    }

    const storageFailure = new OwnerRouteFixture();
    const seededKeys = new Set(storageFailure.storage.objects.keys());
    storageFailure.storage.failPutNumber = 2;
    const response = await postCard(storageFailure);
    assert.equal(response.status, 500);
    assert.equal(storageFailure.storage.ownedDeletes.length, 1);
    assert.deepEqual(new Set(storageFailure.storage.objects.keys()), seededKeys);
    assert.equal(storageFailure.createInputs.length, 0);
});

test('committed create, avatar, and card-side writes recover after the repository throws', async () => {
    const create = new OwnerRouteFixture();
    create.createMode = 'mutate-then-throw';
    const created = await postCard(create);
    const createdBody = await created.json() as {
        card?: { id: string };
    };
    assert.equal(created.status, 201, JSON.stringify(createdBody));
    assert.equal(createdBody.card?.id, create.createInputs[0]?.id);
    assert.equal(create.storage.ownedDeletes.length, 0);
    for (const put of create.storage.puts) {
        assert.equal(create.storage.objects.has(put.key), true);
    }

    const avatar = new OwnerRouteFixture();
    const oldAvatar = 'protected/platform/ambiguous-old-avatar.webp';
    avatar.profile.avatar_object_key = oldAvatar;
    avatar.storage.seed(oldAvatar);
    avatar.updateAvatarMode = 'mutate-then-throw';
    avatar.uploads.next = mediaUpload({ expectedUpdatedAt: '1000' });
    const avatarResponse = await avatar.app.request(
        'http://ims.test/api/community/exchange/uploads/avatar',
        { method: 'PUT', headers: bearerHeaders(), body: new FormData() }
    );
    const avatarBody = await avatarResponse.json();
    assert.equal(avatarResponse.status, 200, JSON.stringify(avatarBody));
    const avatarKey = avatar.profileAvatarInputs[0]?.avatarObjectKey;
    assert.ok(avatarKey);
    assert.equal(avatar.profile.avatar_object_key, avatarKey);
    assert.equal(avatar.storage.objects.has(avatarKey), true);
    assert.equal(avatar.storage.ownedDeletes.length, 0);

    const side = new OwnerRouteFixture();
    side.updateMediaMode = 'mutate-then-throw';
    side.uploads.next = mediaUpload({
        cardId: 'owner-card',
        expectedRevision: '1'
    });
    const sideResponse = await side.app.request(
        'http://ims.test/api/community/exchange/uploads/front',
        { method: 'PUT', headers: bearerHeaders(), body: new FormData() }
    );
    const sideBody = await sideResponse.json();
    assert.equal(sideResponse.status, 200, JSON.stringify(sideBody));
    const sideKey = side.mediaInputs[0]?.objectKey;
    assert.ok(sideKey);
    assert.equal(side.cards.get('owner-card')?.front_object_key, sideKey);
    assert.equal(side.storage.objects.has(sideKey), true);
    assert.equal(side.storage.ownedDeletes.length, 0);
});

test('failed confirmation reads preserve objects that ambiguous mutations may reference', async () => {
    const create = new OwnerRouteFixture();
    create.createMode = 'mutate-then-throw';
    create.failCardConfirmationRead = true;
    const created = await postCard(create);
    assert.equal(created.status, 500);
    assert.equal(create.storage.ownedDeletes.length, 0);
    assert.equal(create.cards.has(create.createInputs[0]!.id), true);
    for (const put of create.storage.puts) {
        assert.equal(create.storage.objects.has(put.key), true);
    }

    const avatar = new OwnerRouteFixture();
    avatar.updateAvatarMode = 'mutate-then-throw';
    avatar.failProfileConfirmationRead = true;
    avatar.uploads.next = mediaUpload({ expectedUpdatedAt: '1000' });
    const avatarResponse = await avatar.app.request(
        'http://ims.test/api/community/exchange/uploads/avatar',
        { method: 'PUT', headers: bearerHeaders(), body: new FormData() }
    );
    assert.equal(avatarResponse.status, 500);
    const avatarKey = avatar.profileAvatarInputs[0]!.avatarObjectKey!;
    assert.equal(avatar.profile.avatar_object_key, avatarKey);
    assert.equal(avatar.storage.objects.has(avatarKey), true);
    assert.equal(avatar.storage.ownedDeletes.length, 0);

    const side = new OwnerRouteFixture();
    side.updateMediaMode = 'mutate-then-throw';
    side.failCardConfirmationRead = true;
    side.uploads.next = mediaUpload({
        cardId: 'owner-card',
        expectedRevision: '1'
    });
    const sideResponse = await side.app.request(
        'http://ims.test/api/community/exchange/uploads/back',
        { method: 'PUT', headers: bearerHeaders(), body: new FormData() }
    );
    assert.equal(sideResponse.status, 500);
    const sideKey = side.mediaInputs[0]!.objectKey;
    assert.equal(side.cards.get('owner-card')?.back_object_key, sideKey);
    assert.equal(side.storage.objects.has(sideKey), true);
    assert.equal(side.storage.ownedDeletes.length, 0);
});

test('media CAS conflicts clean the new object and old-object failures enqueue compensation', async () => {
    const conflict = new OwnerRouteFixture();
    conflict.updateMediaMode = 'conflict';
    const seededKeys = new Set(conflict.storage.objects.keys());
    conflict.uploads.next = mediaUpload({
        cardId: 'owner-card',
        expectedRevision: '1'
    });
    const rejected = await conflict.app.request(
        'http://ims.test/api/community/exchange/uploads/front',
        { method: 'PUT', headers: bearerHeaders(), body: new FormData() }
    );
    assert.equal(rejected.status, 409);
    assert.equal(conflict.storage.ownedDeletes.length, 1);
    assert.deepEqual(new Set(conflict.storage.objects.keys()), seededKeys);

    const cleanupFailure = new OwnerRouteFixture();
    const oldFront = cleanupFailure.cards.get('owner-card')!.front_object_key;
    cleanupFailure.storage.failDeletes.add(oldFront);
    cleanupFailure.uploads.next = mediaUpload({
        cardId: 'owner-card',
        expectedRevision: '1'
    });
    const saved = await cleanupFailure.app.request(
        'http://ims.test/api/community/exchange/uploads/front',
        { method: 'PUT', headers: bearerHeaders(), body: new FormData() }
    );
    assert.equal(saved.status, 200);
    assert.deepEqual(cleanupFailure.compensation.enqueued.map((item) => ({
        kind: item.kind,
        payload: item.payload
    })), [{ kind: 'delete-object', payload: { key: oldFront } }]);

    const repositoryFailure = new OwnerRouteFixture();
    repositoryFailure.updateMediaMode = 'throw';
    repositoryFailure.uploads.next = mediaUpload({
        cardId: 'owner-card',
        expectedRevision: '1'
    });
    const failed = await repositoryFailure.app.request(
        'http://ims.test/api/community/exchange/uploads/back',
        { method: 'PUT', headers: bearerHeaders(), body: new FormData() }
    );
    assert.equal(failed.status, 500);
    assert.equal(repositoryFailure.storage.ownedDeletes.length, 0);
    const uncertainKey = repositoryFailure.mediaInputs[0]!.objectKey;
    assert.equal(repositoryFailure.storage.objects.has(uncertainKey), true);
});

test('owner media is protected, private, and inaccessible through another account card', async () => {
    const fixture = new OwnerRouteFixture();
    const response = await fixture.app.request(
        'http://ims.test/api/community/exchange/me/cards/owner-card/media/front',
        { headers: bearerHeaders(), redirect: 'manual' }
    );
    assert.equal(response.status, 307);
    assert.match(response.headers.get('location') || '', /^https:\/\/private-media\./);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.match(response.headers.get('vary') || '', /Authorization/);
    assert.deepEqual(fixture.storage.readUrls.at(-1), {
        key: ownerCard().front_object_key,
        method: 'GET'
    });

    const head = await fixture.app.request(
        'http://ims.test/api/community/exchange/me/cards/owner-card/media/back',
        { method: 'HEAD', headers: bearerHeaders(), redirect: 'manual' }
    );
    assert.equal(head.status, 307);
    assert.equal(fixture.storage.readUrls.at(-1)?.method, 'HEAD');

    const readsBeforeOther = fixture.storage.readUrls.length;
    assert.equal((await fixture.app.request(
        'http://ims.test/api/community/exchange/me/cards/other-card/media/front',
        { headers: bearerHeaders() }
    )).status, 404);
    assert.equal(fixture.storage.readUrls.length, readsBeforeOther);
});

test('card creation uses IP and account upload limits before multipart parsing', async () => {
    const ipLimited = new OwnerRouteFixture();
    ipLimited.rateLimiter.deniedBuckets.add('fudaba-upload-attempt');
    const ipResponse = await postCard(ipLimited);
    assert.equal(ipResponse.status, 429);
    assert.equal(ipLimited.uploads.calls.length, 0);
    assert.equal(ipLimited.storage.puts.length, 0);

    const accountLimited = new OwnerRouteFixture();
    accountLimited.rateLimiter.deniedBuckets.add('platform-upload-account');
    const accountResponse = await postCard(accountLimited);
    assert.equal(accountResponse.status, 429);
    assert.equal((await accountResponse.json() as { code: string }).code,
        'PLATFORM_RATE_LIMITED');
    assert.equal(accountLimited.uploads.calls.length, 0);
    assert.equal(accountLimited.storage.puts.length, 0);

    const successful = new OwnerRouteFixture();
    assert.equal((await postCard(successful)).status, 201);
    const buckets = successful.rateLimiter.calls.map((call) => call.bucket);
    assert.equal(buckets.includes('fudaba-upload-attempt'), true);
    assert.equal(buckets.includes('platform-upload-account'), true);
    assert.equal(buckets.includes('fudaba-write-attempt'), false);
});

test('single-side uploads retain their IP and account pre-parse limits', async () => {
    for (const bucket of ['fudaba-upload-attempt', 'platform-upload-account']) {
        const fixture = new OwnerRouteFixture();
        fixture.rateLimiter.deniedBuckets.add(bucket);
        const response = await fixture.app.request(
            'http://ims.test/api/community/exchange/uploads/avatar',
            { method: 'PUT', headers: bearerHeaders(), body: new FormData() }
        );
        assert.equal(response.status, 429, bucket);
        assert.equal(fixture.uploads.calls.length, 0, bucket);
        assert.equal(fixture.storage.puts.length, 0, bucket);
    }
});
