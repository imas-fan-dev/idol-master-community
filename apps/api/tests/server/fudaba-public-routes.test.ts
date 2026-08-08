import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHonoApp } from '@/app';
import { PLATFORM_ACCESS_TOKEN_COOKIE } from '@/domains/platform-auth/platform-auth-session';
import type {
    FudabaPublicCardRecord,
    FudabaPublicOfficeDetailRecord,
    FudabaPublicOfficeRecord,
    FudabaRepository,
    ListFudabaPublicCardsInput,
    ListFudabaPublicOfficesInput,
    PlatformAccountStatus
} from '@/ports/repositories';
import type {
    ListedObject,
    ObjectStorage,
    PutObjectOptions,
    StoredObject
} from '@/ports/object-storage';
import type { RuntimeServices } from '@/ports/runtime-services';

const NOW = Date.now();
const CREATED_AT = '2026-08-02T00:00:00.000Z';

class PublicMediaStorage implements ObjectStorage {
    async createPublicReadUrl(key: string): Promise<string | null> {
        return key.startsWith('public/')
            ? `https://media.example.test/${key}`
            : null;
    }
    async get(): Promise<StoredObject | null> { return null; }
    async put(
        _key: string,
        body: Uint8Array,
        options: PutObjectOptions = {}
    ): Promise<StoredObject> {
        return {
            body,
            size: body.byteLength,
            contentType: options.contentType || 'application/octet-stream',
            etag: 'unused'
        };
    }
    async delete(): Promise<void> {}
    async exists(): Promise<boolean> { return false; }
    async copy(): Promise<void> {}
    async move(): Promise<void> {}
    async list(): Promise<ListedObject[]> { return []; }
    async deletePrefix(): Promise<void> {}
}

function publicCard(overrides: Partial<FudabaPublicCardRecord> = {}): FudabaPublicCardRecord {
    return {
        id: 'card-a',
        producer_name: 'Producer A',
        display_name: 'Card A',
        series_code: '765',
        favorite_idol: 'Haruka',
        front_object_key: 'public/cards/card-a/front.webp',
        back_object_key: 'public/cards/card-a/back.webp',
        accent: '#4f64dd',
        bio: 'Public bio',
        trade_note: 'Trade note',
        available: true,
        source_url: null,
        source_label: null,
        source_credit: null,
        created_at: CREATED_AT,
        like_count: 2,
        favorite_count: 1,
        viewer_liked: false,
        viewer_favorited: false,
        ...overrides
    };
}

function publicOffice(): FudabaPublicOfficeRecord {
    return {
        id: 'office-a',
        slug: '上海-office-a',
        name: 'Office A',
        intro: 'Public intro',
        city: 'Shanghai',
        accent: '#ef5b6c',
        cover_object_key: 'public/offices/office-a/cover.webp',
        is_open: true,
        visitor_count: 7,
        series_codes: ['765']
    };
}

class PublicFudabaFixture {
    lastOfficeInput: ListFudabaPublicOfficesInput | null = null;
    lastCardInput: ListFudabaPublicCardsInput | null = null;
    officeVisible = true;
    card = publicCard();

    readonly repository = {
        listPublicSeries: async () => [{
            id: 1,
            code: '765',
            display_name: '765PRO',
            color: '#f34f6d',
            display_order: 0,
            icon_object_key: 'public/agencies/765.webp',
            image_transform: {
                fit: 'contain' as const,
                focalX: 0.5,
                focalY: 0.5,
                zoom: 1,
                rotation: 0 as const
            },
            active_office_count: 1
        }],
        listPublicOffices: async (input: ListFudabaPublicOfficesInput) => {
            this.lastOfficeInput = input;
            const row = {
                ...publicOffice(),
                owner_account_id: 'must-not-leak',
                address: 'must-not-leak',
                latitude: 31.2,
                longitude: 121.4
            };
            return input.limit > 1 ? [row, { ...row, id: 'office-b' }] : [row];
        },
        findPublicOfficeBySlug: async (
            _slug: string,
            viewerAccountId: string | null
        ): Promise<FudabaPublicOfficeDetailRecord | null> => {
            if (!this.officeVisible) return null;
            return {
                ...publicOffice(),
                cards: [{
                    ...this.card,
                    viewer_liked: viewerAccountId === 'platform-viewer',
                    viewer_favorited: viewerAccountId === 'platform-viewer',
                    pinned_at: CREATED_AT,
                    position_x: 50,
                    position_y: 40,
                    rotation: 2,
                    z_index: 3,
                    revision: 4,
                    updated_at: CREATED_AT,
                    viewer_owned: viewerAccountId === 'platform-viewer'
                }]
            };
        },
        listPublicCards: async (input: ListFudabaPublicCardsInput) => {
            this.lastCardInput = input;
            const row = {
                ...this.card,
                viewer_liked: input.viewerAccountId === 'platform-viewer',
                viewer_favorited: input.viewerAccountId === 'platform-viewer'
            };
            return input.limit > 1
                ? [row, { ...row, id: 'card-b' }]
                : [row];
        }
    } as unknown as FudabaRepository;
}

function runtime(
    fudaba: PublicFudabaFixture,
    options: {
        enabled?: boolean;
        accountStatus?: PlatformAccountStatus;
    } = {}
): RuntimeServices {
    const status = options.accountStatus ?? 'active';
    return {
        fudaba: fudaba.repository,
        storage: new PublicMediaStorage(),
        platformTokens: {
            async sign() { return 'valid-platform'; },
            async verify(token: string) {
                if (token !== 'valid-platform') throw new Error('invalid token');
                return {
                    iss: 'imsweb' as const,
                    aud: 'ims-platform' as const,
                    kind: 'platform' as const,
                    id: 'platform-viewer',
                    tokenVersion: 0,
                    sessionId: 'platform-session',
                    csrfSecret: 'csrf-secret',
                    jti: 'access-token',
                    iat: Math.floor(NOW / 1000),
                    exp: Math.floor(NOW / 1000) + 300
                };
            }
        },
        platformAccounts: {
            async findRefreshSessionById() {
                return {
                    id: 'platform-session',
                    account_id: 'platform-viewer',
                    token_hash: 'hash',
                    previous_token_hash: null,
                    csrf_hash: 'csrf-hash',
                    expires_at: NOW + 60_000,
                    created_at: NOW,
                    updated_at: NOW,
                    revoked_at: null
                };
            },
            async findAccountWithProfileById() {
                return {
                    account: {
                        id: 'platform-viewer',
                        status,
                        token_version: 0,
                        created_at: NOW,
                        updated_at: NOW,
                        deleted_at: status === 'deleted' ? NOW : null
                    },
                    profile: {
                        account_id: 'platform-viewer',
                        display_name: 'Platform Viewer',
                        avatar_object_key: null,
                        avatar_external_url: null,
                        home_city: null,
                        bio: '',
                        updated_at: NOW
                    }
                };
            },
            async revokeRefreshSession() { return true; }
        } as unknown as NonNullable<RuntimeServices['platformAccounts']>,
        config: { fudabaPublicReadEnabled: options.enabled ?? true }
    };
}

test('Fudaba public read feature gate hides every route by default', async () => {
    const fudaba = new PublicFudabaFixture();
    const app = createHonoApp(() => runtime(fudaba, { enabled: false }));
    const response = await app.request('http://ims.test/api/community/exchange/series');
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
});

test('Fudaba public series fails closed when icon storage is unavailable',
    async () => {
        const fudaba = new PublicFudabaFixture();
        const app = createHonoApp(() => ({
            ...runtime(fudaba),
            storage: undefined
        }));

        const response = await app.request(
            'http://ims.test/api/community/exchange/series'
        );
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), {
            error: 'Internal server error'
        });
    });

test('anonymous Fudaba discovery exposes only public projections and stable cursors', async () => {
    const fudaba = new PublicFudabaFixture();
    const app = createHonoApp(() => runtime(fudaba));
    const seriesResponse = await app.request(
        'http://ims.test/api/community/exchange/series'
    );
    assert.equal(seriesResponse.status, 200);
    assert.deepEqual(await seriesResponse.json(), {
        items: [{
            id: 1,
            code: '765',
            displayName: '765PRO',
            displayOrder: 0,
            color: '#f34f6d',
            iconUrl: 'https://media.example.test/public/agencies/765.webp',
            imageTransform: {
                fit: 'contain',
                focalX: 0.5,
                focalY: 0.5,
                zoom: 1,
                rotation: 0
            },
            activeOfficeCount: 1
        }]
    });
    const response = await app.request(
        'http://ims.test/api/community/exchange/offices?city=Shanghai&limit=1',
        { headers: { cookie: 'ims_admin_access=backoffice-token' } }
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const body = await response.json() as {
        items: Record<string, unknown>[];
        pageInfo: { hasNextPage: boolean; nextCursor: string };
    };
    assert.equal(body.pageInfo.hasNextPage, true);
    assert.ok(body.pageInfo.nextCursor);
    assert.equal(body.items[0].coverUrl,
        'https://media.example.test/public/offices/office-a/cover.webp');
    const serialized = JSON.stringify(body);
    for (const forbidden of [
        'owner_account_id', 'cover_object_key', 'address', 'latitude', 'longitude'
    ]) {
        assert.equal(serialized.includes(forbidden), false, forbidden);
    }
    assert.deepEqual(fudaba.lastOfficeInput, {
        city: 'Shanghai',
        limit: 2
    });

    const mismatched = await app.request(
        `http://ims.test/api/community/exchange/offices?city=Beijing&limit=1&cursor=${body.pageInfo.nextCursor}`
    );
    assert.equal(mismatched.status, 400);
});

test('valid Platform auth adds viewer flags while Backoffice remains anonymous', async () => {
    const fudaba = new PublicFudabaFixture();
    const app = createHonoApp(() => runtime(fudaba));
    const anonymous = await app.request('http://ims.test/api/community/exchange/cards', {
        headers: { cookie: 'ims_admin_access=backoffice-token' }
    });
    assert.equal(anonymous.status, 200);
    assert.equal(fudaba.lastCardInput?.viewerAccountId, null);

    const authenticated = await app.request(
        'http://ims.test/api/community/exchange/cards',
        { headers: { authorization: 'Bearer valid-platform' } }
    );
    assert.equal(authenticated.status, 200);
    assert.equal(fudaba.lastCardInput?.viewerAccountId, 'platform-viewer');
    const body = await authenticated.json() as {
        items: Array<{ interactions: { viewerLiked: boolean; viewerFavorited: boolean } }>;
    };
    assert.deepEqual(body.items[0].interactions, {
        likes: 2,
        favorites: 1,
        viewerLiked: true,
        viewerFavorited: true
    });
    assert.equal(JSON.stringify(body).includes('object_key'), false);

    const office = await app.request(
        'http://ims.test/api/community/exchange/offices/上海-office-a',
        { headers: { authorization: 'Bearer valid-platform' } }
    );
    assert.equal(office.status, 200);
    const officeBody = await office.json() as {
        office: {
            cards: Array<{
                viewerOwned: boolean;
                placement: Record<string, unknown>;
            }>;
        };
    };
    assert.equal(officeBody.office.cards[0]?.viewerOwned, true);
    assert.deepEqual(officeBody.office.cards[0]?.placement, {
        pinnedAt: CREATED_AT,
        x: 50,
        y: 40,
        rotation: 2,
        zIndex: 3,
        revision: 4,
        updatedAt: CREATED_AT
    });
});

test('invalid or blocked Platform credentials never downgrade to anonymous', async () => {
    const fudaba = new PublicFudabaFixture();
    const activeApp = createHonoApp(() => runtime(fudaba));
    const invalid = await activeApp.request(
        'http://ims.test/api/community/exchange/cards',
        { headers: { cookie: `${PLATFORM_ACCESS_TOKEN_COOKIE}=invalid` } }
    );
    assert.equal(invalid.status, 401);

    const suspendedApp = createHonoApp(() => runtime(fudaba, {
        accountStatus: 'suspended'
    }));
    const suspended = await suspendedApp.request(
        'http://ims.test/api/community/exchange/cards',
        { headers: { authorization: 'Bearer valid-platform' } }
    );
    assert.equal(suspended.status, 403);
});

test('office visibility, query validation, and public media fail closed', async () => {
    const fudaba = new PublicFudabaFixture();
    const app = createHonoApp(() => runtime(fudaba));
    fudaba.officeVisible = false;
    assert.equal((await app.request(
        'http://ims.test/api/community/exchange/offices/上海-office-a'
    )).status, 404);
    assert.equal((await app.request(
        'http://ims.test/api/community/exchange/offices?bbox=1,2,3,4'
    )).status, 400);
    assert.equal((await app.request(
        'http://ims.test/api/community/exchange/cards?available=yes'
    )).status, 400);

    fudaba.card = publicCard({ front_object_key: 'private/card-a/front.webp' });
    const unavailable = await app.request(
        'http://ims.test/api/community/exchange/cards'
    );
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), { error: 'Internal server error' });
});

test('Fudaba public queries reject duplicate, out-of-range, and mismatched cursor input', async () => {
    const fudaba = new PublicFudabaFixture();
    const app = createHonoApp(() => runtime(fudaba));
    for (const path of [
        '/api/community/exchange/offices?city=Shanghai&city=Beijing',
        '/api/community/exchange/offices?limit=0',
        '/api/community/exchange/offices?limit=51',
        '/api/community/exchange/offices?cursor=not-a-cursor',
        '/api/community/exchange/cards?series=invalid%21',
        '/api/community/exchange/cards?office=invalid%2Fslug',
        '/api/community/exchange/offices/invalid_slug',
        '/api/community/exchange/offices/office-a?unexpected=true'
    ]) {
        assert.equal((await app.request(`http://ims.test${path}`)).status, 400, path);
    }

    const firstPage = await app.request(
        'http://ims.test/api/community/exchange/cards?series=765&limit=1'
    );
    assert.equal(firstPage.status, 200);
    const body = await firstPage.json() as {
        pageInfo: { nextCursor: string | null };
    };
    assert.ok(body.pageInfo.nextCursor);
    const mismatch = await app.request(
        'http://ims.test/api/community/exchange/cards' +
        `?series=cg&limit=1&cursor=${body.pageInfo.nextCursor}`
    );
    assert.equal(mismatch.status, 400);
});

test('Fudaba public surface registers no mutation routes', async () => {
    const fudaba = new PublicFudabaFixture();
    const app = createHonoApp(() => runtime(fudaba));
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const response = await app.request(
            'http://ims.test/api/community/exchange/cards',
            { method }
        );
        assert.equal(response.status, 404, method);
    }
    const invalidCredentialMutation = await app.request(
        'http://ims.test/api/community/exchange/cards',
        {
            method: 'POST',
            headers: { authorization: 'Bearer invalid-platform' }
        }
    );
    assert.equal(invalidCredentialMutation.status, 404);
});
