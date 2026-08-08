import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createHonoApp } from '@/app';
import {
    BACKOFFICE_ACCESS_TOKEN_COOKIE,
    BACKOFFICE_CSRF_TOKEN_COOKIE
} from '@/domains/backoffice-auth/backoffice-auth-session';
import {
    PLATFORM_ACCESS_TOKEN_COOKIE,
    PLATFORM_CSRF_TOKEN_COOKIE
} from '@/domains/platform-auth/platform-auth-session';
import type { RateLimiter } from '@/ports/cache';
import type {
    AuditLogInput,
    BackofficeAccountRecord,
    FudabaOfficeLocationReviewRecord,
    FudabaOfficePublicLocationRecord,
    FudabaOfficeRecord,
    FudabaPublicMapOfficeRecord,
    FudabaRepository,
    ListFudabaPublicMapOfficesInput,
    PlatformAccountStatus,
    PlatformAccountWithProfile,
    PlatformRefreshSessionRecord
} from '@/ports/repositories';
import type { RuntimeServices } from '@/ports/runtime-services';

const ACCOUNT_ID = 'location-owner';
const OTHER_ACCOUNT_ID = 'other-owner';
const OFFICE_ID = 'location-office';
const PLATFORM_TOKEN = 'platform-location-token';
const PLATFORM_CSRF = 'platform-location-csrf';
const BACKOFFICE_TOKEN = 'backoffice-location-token';
const BACKOFFICE_CSRF = 'backoffice-location-csrf';
const SUBMITTED_AT = '2026-08-03T01:00:00.000Z';
const REVIEWED_AT = '2026-08-03T02:00:00.000Z';

function csrfHash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function officeRecord(
    id = OFFICE_ID,
    ownerAccountId = ACCOUNT_ID,
    status: FudabaOfficeRecord['status'] = 'active'
): FudabaOfficeRecord {
    return {
        id,
        owner_account_id: ownerAccountId,
        slug: id,
        name: `Office ${id}`,
        intro: 'Private intro',
        city: 'Shanghai',
        address: 'Private exact address',
        latitude: 31.2304,
        longitude: 121.4737,
        accent: '#ef5b6c',
        cover_object_key: null,
        pending_cover_object_key: null,
        pending_cover_submitted_at: null,
        is_open: true,
        visitor_count: 0,
        status,
        revision: 0,
        created_at: SUBMITTED_AT,
        updated_at: SUBMITTED_AT,
        archived_at: status === 'archived' ? SUBMITTED_AT : null
    };
}

function pendingLocation(
    officeId = OFFICE_ID,
    overrides: Partial<FudabaOfficePublicLocationRecord> = {}
): FudabaOfficePublicLocationRecord {
    return {
        office_id: officeId,
        latitude_e1: 312,
        longitude_e1: 1215,
        review_state: 'pending',
        revision: 0,
        submitted_at: SUBMITTED_AT,
        reviewed_at: null,
        reviewed_by: null,
        review_note: '',
        ...overrides
    };
}

class ControlledRateLimiter implements RateLimiter {
    readonly deniedBuckets = new Set<string>();
    readonly calls: Array<{
        bucket: string;
        key: string;
        limit: number;
        windowSeconds: number;
    }> = [];

    async consume(
        bucket: string,
        key: string,
        limit: number,
        windowSeconds: number
    ): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
        this.calls.push({ bucket, key, limit, windowSeconds });
        const allowed = !this.deniedBuckets.has(bucket);
        return {
            allowed,
            remaining: allowed ? Math.max(0, limit - 1) : 0,
            resetAt: Date.now() + 60_000
        };
    }
}

interface FixtureOptions {
    publicReadEnabled?: boolean;
    mapEnabled?: boolean;
    writeEnabled?: boolean;
    accountStatus?: PlatformAccountStatus;
    backofficeDept?: string;
    currentBackofficeDept?: string;
    currentBackofficeMissing?: boolean;
    auditFailure?: boolean;
}

class LocationRouteFixture {
    publicReadEnabled: boolean;
    mapEnabled: boolean;
    writeEnabled: boolean;
    accountStatus: PlatformAccountStatus;
    backofficeDept: string;
    currentBackofficeAccount: BackofficeAccountRecord | null;
    auditFailure: boolean;
    readonly offices = new Map<string, FudabaOfficeRecord>();
    readonly locations = new Map<string, FudabaOfficePublicLocationRecord>();
    readonly mapInputs: ListFudabaPublicMapOfficesInput[] = [];
    readonly reviewInputs: Array<{
        officeId: string;
        decision: 'publish' | 'reject';
        expectedRevision: number;
        reviewNote: string;
        reviewedAt: string;
        reviewedBy: number;
        reviewOperationId: string;
        audit: AuditLogInput;
    }> = [];
    readonly audit: AuditLogInput[] = [];
    readonly rateLimiter = new ControlledRateLimiter();
    readonly mapRows: FudabaPublicMapOfficeRecord[] = [
        {
            id: 'map-office-a',
            slug: 'map-office-a',
            name: 'Map Office A',
            city: 'Shanghai',
            accent: '#ef5b6c',
            is_open: true,
            series_codes: ['765'],
            latitude_e1: 312,
            longitude_e1: 1215
        },
        {
            id: 'map-office-b',
            slug: 'map-office-b',
            name: 'Map Office B',
            city: 'Beijing',
            accent: '#336699',
            is_open: false,
            series_codes: ['cg'],
            latitude_e1: -32,
            longitude_e1: -456
        }
    ];
    readonly app: ReturnType<typeof createHonoApp>;

    constructor(options: FixtureOptions = {}) {
        this.publicReadEnabled = options.publicReadEnabled ?? true;
        this.mapEnabled = options.mapEnabled ?? true;
        this.writeEnabled = options.writeEnabled ?? true;
        this.accountStatus = options.accountStatus ?? 'active';
        this.backofficeDept = options.backofficeDept ?? 'op';
        this.currentBackofficeAccount = options.currentBackofficeMissing
            ? null
            : {
                id: 7,
                username: 'current-location-reviewer',
                password: 'hash',
                dept: options.currentBackofficeDept ?? this.backofficeDept,
                producername: 'Current Reviewer',
                admin_role: 'admin'
            };
        this.auditFailure = options.auditFailure ?? false;
        this.offices.set(OFFICE_ID, officeRecord());
        this.offices.set('other-office', officeRecord('other-office', OTHER_ACCOUNT_ID));
        this.app = createHonoApp(() => this.runtime());
    }

    private identity(): PlatformAccountWithProfile {
        return {
            account: {
                id: ACCOUNT_ID,
                status: this.accountStatus,
                token_version: 0,
                created_at: 1_700_000_000_000,
                updated_at: 1_700_000_000_000,
                deleted_at: this.accountStatus === 'deleted'
                    ? 1_700_000_000_000
                    : null
            },
            profile: {
                account_id: ACCOUNT_ID,
                display_name: 'Location Owner',
                avatar_object_key: null,
                avatar_external_url: null,
                home_city: 'Shanghai',
                bio: '',
                updated_at: 1_700_000_000_000
            }
        };
    }

    private readonly session: PlatformRefreshSessionRecord = {
        id: 'location-session',
        account_id: ACCOUNT_ID,
        token_hash: 'token-hash',
        previous_token_hash: null,
        csrf_hash: csrfHash(PLATFORM_CSRF),
        expires_at: Date.now() + 60 * 60 * 1000,
        created_at: Date.now(),
        updated_at: Date.now(),
        revoked_at: null
    };

    readonly fudaba = {
        listPublicMapOffices: async (input: ListFudabaPublicMapOfficesInput) => {
            this.mapInputs.push(input);
            return this.mapRows.slice(0, input.limit);
        },
        findOfficeById: async (id: string) => this.offices.get(id) ?? null,
        findOfficePublicLocationForOwner: async (
            officeId: string,
            ownerAccountId: string
        ) => this.offices.get(officeId)?.owner_account_id === ownerAccountId
            ? this.locations.get(officeId) ?? null
            : null,
        saveOfficePublicLocationForOwner: async (input: {
            officeId: string;
            ownerAccountId: string;
            latitudeE1: number;
            longitudeE1: number;
            expectedRevision: number | null;
            submittedAt: string;
        }) => {
            const office = this.offices.get(input.officeId);
            if (
                !office || office.owner_account_id !== input.ownerAccountId ||
                office.status !== 'active' || this.accountStatus !== 'active'
            ) {
                return { status: 'unavailable' as const };
            }
            const current = this.locations.get(input.officeId);
            if (
                (current && current.revision !== input.expectedRevision) ||
                (!current && input.expectedRevision !== null)
            ) {
                return current
                    ? { status: 'conflict' as const, revision: current.revision }
                    : { status: 'unavailable' as const };
            }
            const saved = pendingLocation(input.officeId, {
                latitude_e1: input.latitudeE1,
                longitude_e1: input.longitudeE1,
                revision: current ? current.revision + 1 : 0,
                submitted_at: input.submittedAt
            });
            this.locations.set(input.officeId, saved);
            return { status: 'saved' as const, location: { ...saved } };
        },
        withdrawOfficePublicLocationForOwner: async (input: {
            officeId: string;
            ownerAccountId: string;
            expectedRevision: number;
        }) => {
            const office = this.offices.get(input.officeId);
            const current = this.locations.get(input.officeId);
            if (!office || office.owner_account_id !== input.ownerAccountId || !current) {
                return { status: 'unavailable' as const };
            }
            if (current.revision !== input.expectedRevision) {
                return { status: 'conflict' as const, revision: current.revision };
            }
            this.locations.delete(input.officeId);
            return { status: 'saved' as const, location: current };
        },
        listOfficeLocationReviews: async (input: {
            reviewState?: FudabaOfficePublicLocationRecord['review_state'];
            limit: number;
        }): Promise<FudabaOfficeLocationReviewRecord[]> => [...this.locations.values()]
            .filter((location) => !input.reviewState ||
                location.review_state === input.reviewState)
            .slice(0, input.limit)
            .map((location) => ({
                ...location,
                office_name: this.offices.get(location.office_id)?.name ?? 'Office',
                office_city: this.offices.get(location.office_id)?.city ?? 'Shanghai',
                owner_account_id: this.offices.get(location.office_id)?.owner_account_id ?? ''
            })),
        reviewOfficePublicLocation: async (input: {
            officeId: string;
            decision: 'publish' | 'reject';
            expectedRevision: number;
            reviewedAt: string;
            reviewedBy: number;
            reviewNote: string;
            reviewOperationId: string;
            audit: AuditLogInput;
        }) => {
            this.reviewInputs.push(input);
            const current = this.locations.get(input.officeId);
            if (!current) return { status: 'unavailable' as const };
            if (current.revision !== input.expectedRevision) {
                return { status: 'conflict' as const, revision: current.revision };
            }
            if (this.auditFailure) throw new Error('injected audit failure');
            const saved: FudabaOfficePublicLocationRecord = {
                ...current,
                review_state: input.decision === 'publish' ? 'published' : 'rejected',
                revision: current.revision + 1,
                reviewed_at: input.reviewedAt,
                reviewed_by: input.reviewedBy,
                review_note: input.reviewNote
            };
            this.locations.set(input.officeId, saved);
            this.audit.push(input.audit);
            return { status: 'saved' as const, location: { ...saved } };
        }
    } as unknown as FudabaRepository;

    runtime(): RuntimeServices {
        return {
            fudaba: this.fudaba,
            rateLimiter: this.rateLimiter,
            platformAccounts: {
                findRefreshSessionById: async (id: string) =>
                    id === this.session.id ? { ...this.session } : null,
                findAccountWithProfileById: async (id: string) =>
                    id === ACCOUNT_ID ? this.identity() : null,
                revokeRefreshSession: async () => true
            } as unknown as NonNullable<RuntimeServices['platformAccounts']>,
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
                        sessionId: 'location-session',
                        csrfSecret: PLATFORM_CSRF,
                        jti: 'location-access',
                        iat: now,
                        exp: now + 900
                    };
                }
            },
            backofficeTokens: {
                async sign() { return BACKOFFICE_TOKEN; },
                verify: async (token: string) => {
                    if (token !== BACKOFFICE_TOKEN) throw new Error('wrong token realm');
                    return {
                        iss: 'imsweb' as const,
                        aud: 'ims-backoffice' as const,
                        kind: 'backoffice' as const,
                        id: 7,
                        username: 'location-reviewer',
                        producername: 'Reviewer',
                        dept: this.backofficeDept,
                        csrfSecret: BACKOFFICE_CSRF
                    };
                }
            },
            backofficeAuth: {
                findUserById: async (id: number) =>
                    id === 7 ? this.currentBackofficeAccount : null
            } as NonNullable<RuntimeServices['backofficeAuth']>,
            audit: {
                insertAuditLog: async (input) => { this.audit.push(input); },
                listRecentAuditLogs: async () => []
            },
            config: {
                fudabaPublicReadEnabled: this.publicReadEnabled,
                fudabaWriteEnabled: this.writeEnabled,
                fudabaMapEnabled: this.mapEnabled,
                fudabaMapStyleUrl: '/api/community/exchange/map/style.json'
            }
        };
    }
}

function platformBearerHeaders(extra: Record<string, string> = {}) {
    return { authorization: `Bearer ${PLATFORM_TOKEN}`, ...extra };
}

function platformCookieHeaders(includeCsrf = true) {
    return {
        cookie: `${PLATFORM_ACCESS_TOKEN_COOKIE}=${PLATFORM_TOKEN}; ` +
            `${PLATFORM_CSRF_TOKEN_COOKIE}=${PLATFORM_CSRF}`,
        ...(includeCsrf ? { 'x-csrftoken': PLATFORM_CSRF } : {})
    };
}

function backofficeCookieHeaders(includeCsrf = true) {
    return {
        cookie: `${BACKOFFICE_ACCESS_TOKEN_COOKIE}=${BACKOFFICE_TOKEN}; ` +
            `${BACKOFFICE_CSRF_TOKEN_COOKIE}=${BACKOFFICE_CSRF}`,
        ...(includeCsrf ? { 'x-csrftoken': BACKOFFICE_CSRF } : {})
    };
}

test('map config and offices require both flags and expose strict regional DTOs', async () => {
    for (const options of [
        { publicReadEnabled: false, mapEnabled: true },
        { publicReadEnabled: true, mapEnabled: false }
    ]) {
        const disabled = new LocationRouteFixture(options);
        assert.equal((await disabled.app.request(
            'http://ims.test/api/community/exchange/map/config'
        )).status, 404);
        assert.equal((await disabled.app.request(
            'http://ims.test/api/community/exchange/map/offices?bbox=-180,-90,180,90'
        )).status, 404);
    }

    const fixture = new LocationRouteFixture();
    const config = await fixture.app.request(
        'http://ims.test/api/community/exchange/map/config'
    );
    assert.equal(config.status, 200);
    assert.deepEqual(await config.json(), {
        styleUrl: '/api/community/exchange/map/style.json'
    });
    assert.equal(config.headers.get('cache-control'), 'private, no-store');

    const response = await fixture.app.request(
        'http://ims.test/api/community/exchange/map/offices?' +
        'bbox=121.41,31.11,121.59,31.29&city=Shanghai&series=765&open=true&limit=1'
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
        items: [{
            id: 'map-office-a',
            slug: 'map-office-a',
            name: 'Map Office A',
            city: 'Shanghai',
            accent: '#ef5b6c',
            isOpen: true,
            seriesCodes: ['765'],
            location: {
                latitude: 31.2,
                longitude: 121.5,
                precision: 'regional'
            }
        }],
        truncated: true
    });
    assert.deepEqual(fixture.mapInputs.at(-1), {
        bbox: { westE1: 1215, southE1: 312, eastE1: 1215, northE1: 312 },
        city: 'Shanghai',
        seriesCode: '765',
        isOpen: true,
        limit: 2
    });

    await fixture.app.request(
        'http://ims.test/api/community/exchange/map/offices?' +
        'bbox=-45.69,-3.29,-45.51,-3.11'
    );
    assert.deepEqual(fixture.mapInputs.at(-1)?.bbox, {
        westE1: -456,
        southE1: -32,
        eastE1: -456,
        northE1: -32
    });
});

test('map query rejects missing, duplicate, unknown, invalid, and antimeridian input', async () => {
    const fixture = new LocationRouteFixture();
    for (const query of [
        '',
        '?bbox=-180,-90,180,90&bbox=-10,-10,10,10',
        '?bbox=-180,-90,180,90&unknown=1',
        '?bbox=170,-10,-170,10',
        '?bbox=-181,-10,10,10',
        '?bbox=-10,10,10,-10',
        '?bbox=-10,-10,10,10&limit=501',
        '?bbox=-10,-10,10,10&open=1'
    ]) {
        const response = await fixture.app.request(
            `http://ims.test/api/community/exchange/map/offices${query}`
        );
        assert.equal(response.status, 400, query);
    }
});

test('owner locations enforce Platform auth, active account, CSRF, quantization, and CAS', async () => {
    const fixture = new LocationRouteFixture();
    assert.equal((await fixture.app.request(
        `http://ims.test/api/community/exchange/me/offices/${OFFICE_ID}/location`
    )).status, 401);
    const empty = await fixture.app.request(
        `http://ims.test/api/community/exchange/me/offices/${OFFICE_ID}/location`,
        { headers: platformBearerHeaders() }
    );
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { location: null });
    assert.equal((await fixture.app.request(
        'http://ims.test/api/community/exchange/me/offices/other-office/location',
        { headers: platformBearerHeaders() }
    )).status, 404);

    const path = `/api/community/exchange/me/offices/${OFFICE_ID}/location`;
    const body = JSON.stringify({
        latitude: -3.24,
        longitude: 121.46,
        expectedRevision: null
    });
    assert.equal((await fixture.app.request(`http://ims.test${path}`, {
        method: 'PUT',
        headers: {
            ...platformCookieHeaders(false),
            'content-type': 'application/json'
        },
        body
    })).status, 403);

    const saved = await fixture.app.request(`http://ims.test${path}`, {
        method: 'PUT',
        headers: {
            ...platformCookieHeaders(),
            'content-type': 'application/json'
        },
        body
    });
    assert.equal(saved.status, 200);
    const savedPayload = await saved.json() as {
        officeLocation: {
            officeId: string;
            location: unknown;
            reviewState: string;
            revision: number;
            submittedAt: string;
            reviewedAt: string | null;
            reviewNote: string;
        };
    };
    assert.equal(
        new Date(savedPayload.officeLocation.submittedAt).toISOString(),
        savedPayload.officeLocation.submittedAt
    );
    assert.deepEqual(savedPayload.officeLocation, {
        officeId: OFFICE_ID,
        location: { latitude: -3.2, longitude: 121.5, precision: 'regional' },
        reviewState: 'pending',
        revision: 0,
        submittedAt: savedPayload.officeLocation.submittedAt,
        reviewedAt: null,
        reviewNote: ''
    });
    const stored = fixture.locations.get(OFFICE_ID);
    assert.equal(stored?.latitude_e1, -32);
    assert.equal(stored?.longitude_e1, 1215);

    for (const latitude of [-60.1, 60.1]) {
        const invalidLatitude = await fixture.app.request(`http://ims.test${path}`, {
            method: 'PUT',
            headers: platformBearerHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify({
                latitude,
                longitude: 121.5,
                expectedRevision: 0
            })
        });
        assert.equal(invalidLatitude.status, 400, `latitude=${latitude}`);
    }

    const stale = await fixture.app.request(`http://ims.test${path}`, {
        method: 'PUT',
        headers: {
            ...platformBearerHeaders({ 'content-type': 'application/json' })
        },
        body: JSON.stringify({ latitude: 31.2, longitude: 121.5, expectedRevision: null })
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json() as { revision: number }).revision, 0);

    const staleDelete = await fixture.app.request(`http://ims.test${path}`, {
        method: 'DELETE',
        headers: platformBearerHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ expectedRevision: 1 })
    });
    assert.equal(staleDelete.status, 409);
    const removed = await fixture.app.request(`http://ims.test${path}`, {
        method: 'DELETE',
        headers: platformBearerHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ expectedRevision: 0 })
    });
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { success: true });

    const restricted = new LocationRouteFixture({ accountStatus: 'restricted' });
    assert.equal((await restricted.app.request(`http://ims.test${path}`, {
        method: 'PUT',
        headers: platformBearerHeaders({ 'content-type': 'application/json' }),
        body
    })).status, 403);
});

test('admin review ignores rollout flags but requires Backoffice op, CSRF, CAS, and audit', async () => {
    const fixture = new LocationRouteFixture({
        publicReadEnabled: false,
        mapEnabled: false,
        writeEnabled: false
    });
    fixture.locations.set(OFFICE_ID, pendingLocation());
    const listPath = '/api/admin/community/exchange/office-locations?state=pending&limit=20';
    assert.equal((await fixture.app.request(`http://ims.test${listPath}`)).status, 401);
    assert.equal((await fixture.app.request(`http://ims.test${listPath}`, {
        headers: platformBearerHeaders()
    })).status, 401);
    const listed = await fixture.app.request(`http://ims.test${listPath}`, {
        headers: { authorization: `Bearer ${BACKOFFICE_TOKEN}` }
    });
    assert.equal(listed.status, 200);
    assert.equal(listed.headers.get('cache-control'), 'private, no-store');
    assert.equal((await listed.json() as { items: unknown[] }).items.length, 1);

    const path = `/api/admin/community/exchange/office-locations/${OFFICE_ID}`;
    const publishBody = JSON.stringify({
        decision: 'publish',
        expectedRevision: 0,
        note: ''
    });
    assert.equal((await fixture.app.request(`http://ims.test${path}`, {
        method: 'PUT',
        headers: {
            ...backofficeCookieHeaders(false),
            'content-type': 'application/json'
        },
        body: publishBody
    })).status, 403);
    assert.equal((await fixture.app.request(`http://ims.test${path}`, {
        method: 'PUT',
        headers: {
            ...backofficeCookieHeaders(),
            'content-type': 'application/json'
        },
        body: JSON.stringify({ decision: 'reject', expectedRevision: 0, note: '   ' })
    })).status, 400);

    const published = await fixture.app.request(`http://ims.test${path}`, {
        method: 'PUT',
        headers: {
            ...backofficeCookieHeaders(),
            'content-type': 'application/json'
        },
        body: publishBody
    });
    assert.equal(published.status, 200);
    assert.equal(fixture.locations.get(OFFICE_ID)?.review_state, 'published');
    assert.equal(fixture.audit.length, 1);
    assert.equal(fixture.audit[0]?.action, '发布 Fudaba 事务所公开位置');
    assert.equal(fixture.audit[0]?.username, 'current-location-reviewer');
    assert.equal(fixture.audit[0]?.producername, 'Current Reviewer');
    assert.match(fixture.reviewInputs[0]?.reviewOperationId ?? '', /^[0-9a-f-]{36}$/);

    const stale = await fixture.app.request(`http://ims.test${path}`, {
        method: 'PUT',
        headers: {
            ...backofficeCookieHeaders(),
            'content-type': 'application/json'
        },
        body: publishBody
    });
    assert.equal(stale.status, 409);
    assert.equal(fixture.audit.length, 1, 'failed review must not be audited');

    const rejected = await fixture.app.request(`http://ims.test${path}`, {
        method: 'PUT',
        headers: {
            ...backofficeCookieHeaders(),
            'content-type': 'application/json'
        },
        body: JSON.stringify({
            decision: 'reject',
            expectedRevision: 1,
            note: '公开精度仍不合适'
        })
    });
    assert.equal(rejected.status, 200);
    assert.equal(fixture.locations.get(OFFICE_ID)?.review_state, 'rejected');
    assert.equal(fixture.audit.at(-1)?.action, '拒绝 Fudaba 事务所公开位置');

    const nonOp = new LocationRouteFixture({ backofficeDept: 'design' });
    assert.equal((await nonOp.app.request(
        'http://ims.test/api/admin/community/exchange/office-locations',
        { headers: { authorization: `Bearer ${BACKOFFICE_TOKEN}` } }
    )).status, 403);

    const deletedCurrentOp = new LocationRouteFixture({
        backofficeDept: 'op',
        currentBackofficeMissing: true
    });
    assert.equal((await deletedCurrentOp.app.request(
        'http://ims.test/api/admin/community/exchange/office-locations',
        { headers: { authorization: `Bearer ${BACKOFFICE_TOKEN}` } }
    )).status, 403);

    const demotedCurrentOp = new LocationRouteFixture({
        backofficeDept: 'op',
        currentBackofficeDept: 'design'
    });
    demotedCurrentOp.locations.set(OFFICE_ID, pendingLocation());
    assert.equal((await demotedCurrentOp.app.request(`http://ims.test${path}`, {
        method: 'PUT',
        headers: {
            ...backofficeCookieHeaders(),
            'content-type': 'application/json'
        },
        body: publishBody
    })).status, 403);
    assert.equal(demotedCurrentOp.locations.get(OFFICE_ID)?.review_state, 'pending');

    const auditFailure = new LocationRouteFixture({ auditFailure: true });
    auditFailure.locations.set(OFFICE_ID, pendingLocation());
    const failedAuditResponse = await auditFailure.app.request(
        `http://ims.test${path}`,
        {
            method: 'PUT',
            headers: {
                ...backofficeCookieHeaders(),
                'content-type': 'application/json'
            },
            body: publishBody
        }
    );
    assert.equal(failedAuditResponse.status, 500);
    assert.equal(auditFailure.locations.get(OFFICE_ID)?.review_state, 'pending');
    assert.equal(auditFailure.locations.get(OFFICE_ID)?.revision, 0);
    assert.equal(auditFailure.audit.length, 0);
});

test('map and location routes enforce dedicated IP and account limits', async () => {
    const mapLimited = new LocationRouteFixture();
    mapLimited.rateLimiter.deniedBuckets.add('fudaba-map-ip');
    const mapResponse = await mapLimited.app.request(
        'http://ims.test/api/community/exchange/map/offices?bbox=-180,-90,180,90'
    );
    assert.equal(mapResponse.status, 429);
    assert.ok(mapResponse.headers.get('retry-after'));
    assert.ok(mapLimited.rateLimiter.calls.some(({ bucket, limit, windowSeconds }) =>
        bucket === 'fudaba-map-ip' && limit === 300 && windowSeconds === 900
    ));

    const ipLimited = new LocationRouteFixture();
    ipLimited.rateLimiter.deniedBuckets.add('fudaba-location-ip');
    const path = `/api/community/exchange/me/offices/${OFFICE_ID}/location`;
    const init = {
        method: 'PUT',
        headers: platformBearerHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ latitude: 31.2, longitude: 121.5, expectedRevision: null })
    };
    assert.equal((await ipLimited.app.request(`http://ims.test${path}`, init)).status, 429);
    assert.ok(ipLimited.rateLimiter.calls.some(({ bucket, limit, windowSeconds }) =>
        bucket === 'fudaba-location-ip' && limit === 60 && windowSeconds === 3600
    ));

    const accountLimited = new LocationRouteFixture();
    accountLimited.rateLimiter.deniedBuckets.add('fudaba-location-account');
    assert.equal((await accountLimited.app.request(
        `http://ims.test${path}`,
        init
    )).status, 429);
    assert.ok(accountLimited.rateLimiter.calls.some(({ bucket, key }) =>
        bucket === 'fudaba-location-account' && key === ACCOUNT_ID
    ));
    assert.ok(accountLimited.rateLimiter.calls.some(({ bucket, limit, windowSeconds }) =>
        bucket === 'fudaba-location-account' && limit === 12 && windowSeconds === 3600
    ));
});
