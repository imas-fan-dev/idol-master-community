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
    FudabaCardPlacementRecord,
    FudabaRepository,
    PlatformAccountStatus
} from '@/ports/repositories';
import type { RuntimeServices } from '@/ports/runtime-services';

const ACCOUNT_ID = 'placement-owner';
const TOKEN = 'placement-access-token';
const CSRF = 'placement-csrf-secret';
const OFFICE_ID = 'placement-office';
const CARD_ID = 'placement-card';

function csrfHash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
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
        const denied = this.deniedBuckets.has(bucket);
        return {
            allowed: !denied,
            remaining: denied ? 0 : limit - 1,
            resetAt: Date.now() + 60_000
        };
    }
}

interface FixtureOptions {
    accountStatus?: PlatformAccountStatus;
    officeOpen?: boolean;
    officeOwnerStatus?: PlatformAccountStatus;
    writeEnabled?: boolean;
}

class PlacementRouteFixture {
    readonly accountStatus: PlatformAccountStatus;
    readonly writeEnabled: boolean;
    officeOpen: boolean;
    officeOwnerStatus: PlatformAccountStatus;
    readonly rateLimiter = new ControlledRateLimiter();
    readonly placements = new Map<string, FudabaCardPlacementRecord>();
    readonly saveInputs: Array<Parameters<
        FudabaRepository['saveCardPlacementForOwner']
    >[0]> = [];
    readonly removeInputs: Array<Parameters<
        FudabaRepository['removeCardPlacementForOwner']
    >[0]> = [];
    inUse = false;
    readonly app: ReturnType<typeof createHonoApp>;

    constructor(options: FixtureOptions = {}) {
        this.accountStatus = options.accountStatus ?? 'active';
        this.officeOpen = options.officeOpen ?? true;
        this.officeOwnerStatus = options.officeOwnerStatus ?? 'active';
        this.writeEnabled = options.writeEnabled ?? true;
        this.app = createHonoApp(() => this.runtime());
    }

    private key(officeId: string, cardId: string): string {
        return `${officeId}\u0000${cardId}`;
    }

    readonly fudaba = {
        saveCardPlacementForOwner: async (
            input: Parameters<FudabaRepository['saveCardPlacementForOwner']>[0]
        ) => {
            this.saveInputs.push(input);
            if (
                input.ownerAccountId !== ACCOUNT_ID ||
                input.officeId !== OFFICE_ID || input.cardId === 'other-card' ||
                !this.officeOpen ||
                !['active', 'restricted'].includes(this.officeOwnerStatus)
            ) {
                return { status: 'unavailable' as const };
            }
            const key = this.key(input.officeId, input.cardId);
            const current = this.placements.get(key);
            if (input.expectedRevision === null) {
                if (current) {
                    return {
                        status: 'conflict' as const,
                        revision: current.revision
                    };
                }
                const placement: FudabaCardPlacementRecord = {
                    office_id: input.officeId,
                    card_id: input.cardId,
                    pinned_at: input.updatedAt,
                    position_x: input.positionX,
                    position_y: input.positionY,
                    rotation: input.rotation,
                    z_index: input.zIndex,
                    revision: 0,
                    updated_at: input.updatedAt
                };
                this.placements.set(key, placement);
                return { status: 'saved' as const, placement, created: true };
            }
            if (!current) return { status: 'unavailable' as const };
            if (current.revision !== input.expectedRevision) {
                return {
                    status: 'conflict' as const,
                    revision: current.revision
                };
            }
            const placement: FudabaCardPlacementRecord = {
                ...current,
                position_x: input.positionX,
                position_y: input.positionY,
                rotation: input.rotation,
                z_index: input.zIndex,
                revision: current.revision + 1,
                updated_at: input.updatedAt
            };
            this.placements.set(key, placement);
            return { status: 'saved' as const, placement, created: false };
        },
        removeCardPlacementForOwner: async (
            input: Parameters<FudabaRepository['removeCardPlacementForOwner']>[0]
        ) => {
            this.removeInputs.push(input);
            if (
                input.ownerAccountId !== ACCOUNT_ID ||
                input.officeId !== OFFICE_ID || input.cardId === 'other-card'
            ) {
                return { status: 'unavailable' as const };
            }
            const key = this.key(input.officeId, input.cardId);
            const current = this.placements.get(key);
            if (!current) return { status: 'unavailable' as const };
            if (current.revision !== input.expectedRevision) {
                return {
                    status: 'conflict' as const,
                    revision: current.revision
                };
            }
            if (this.inUse) {
                return { status: 'in-use' as const, revision: current.revision };
            }
            this.placements.delete(key);
            return {
                status: 'removed' as const,
                revision: current.revision + 1
            };
        }
    } as unknown as FudabaRepository;

    private runtime(): RuntimeServices {
        const now = Date.now();
        return {
            fudaba: this.fudaba,
            rateLimiter: this.rateLimiter,
            platformTokens: {
                async sign() { return TOKEN; },
                async verify(token: string) {
                    if (token !== TOKEN) throw new Error('invalid placement token');
                    return {
                        iss: 'imsweb' as const,
                        aud: 'ims-platform' as const,
                        kind: 'platform' as const,
                        id: ACCOUNT_ID,
                        tokenVersion: 0,
                        sessionId: 'placement-session',
                        csrfSecret: CSRF,
                        jti: 'placement-access',
                        iat: Math.floor(now / 1000),
                        exp: Math.floor(now / 1000) + 900
                    };
                }
            },
            platformAccounts: {
                findRefreshSessionById: async (id: string) => id === 'placement-session'
                    ? {
                        id,
                        account_id: ACCOUNT_ID,
                        token_hash: 'hash',
                        previous_token_hash: null,
                        csrf_hash: csrfHash(CSRF),
                        expires_at: now + 60_000,
                        created_at: now,
                        updated_at: now,
                        revoked_at: null
                    }
                    : null,
                findAccountWithProfileById: async (id: string) => id === ACCOUNT_ID
                    ? {
                        account: {
                            id,
                            status: this.accountStatus,
                            token_version: 0,
                            created_at: now,
                            updated_at: now,
                            deleted_at: this.accountStatus === 'deleted' ? now : null
                        },
                        profile: {
                            account_id: id,
                            display_name: 'Placement Owner',
                            avatar_object_key: null,
                            avatar_external_url: null,
                            home_city: null,
                            bio: '',
                            updated_at: now
                        }
                    }
                    : null,
                revokeRefreshSession: async () => true
            } as unknown as NonNullable<RuntimeServices['platformAccounts']>,
            config: { fudabaWriteEnabled: this.writeEnabled }
        };
    }
}

function bearerHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${TOKEN}`, ...extra };
}

function cookieHeaders(includeHeader: boolean): Record<string, string> {
    return {
        cookie: `${PLATFORM_ACCESS_TOKEN_COOKIE}=${TOKEN}; ` +
            `${PLATFORM_CSRF_TOKEN_COOKIE}=${CSRF}`,
        ...(includeHeader ? { 'x-csrftoken': CSRF } : {})
    };
}

function placementBody(expectedRevision: number | null): Record<string, unknown> {
    return {
        x: 25.5,
        y: 74.5,
        rotation: -3,
        zIndex: 12,
        expectedRevision
    };
}

function path(cardId = CARD_ID): string {
    return `/api/community/exchange/offices/${OFFICE_ID}` +
        `/cards/${cardId}/placement`;
}

test('card placement routes enforce write gate, Platform auth, active status, CSRF, and rate limit',
    async () => {
        const disabled = new PlacementRouteFixture({ writeEnabled: false });
        assert.equal((await disabled.app.request(`http://ims.test${path()}`, {
            method: 'PUT',
            headers: bearerHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify(placementBody(null))
        })).status, 404);

        const fixture = new PlacementRouteFixture();
        assert.equal((await fixture.app.request(`http://ims.test${path()}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(placementBody(null))
        })).status, 401);
        assert.equal((await fixture.app.request(`http://ims.test${path()}`, {
            method: 'PUT',
            headers: {
                ...cookieHeaders(false),
                'content-type': 'application/json'
            },
            body: JSON.stringify(placementBody(null))
        })).status, 403);

        const restricted = new PlacementRouteFixture({ accountStatus: 'restricted' });
        assert.equal((await restricted.app.request(`http://ims.test${path()}`, {
            method: 'PUT',
            headers: bearerHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify(placementBody(null))
        })).status, 403);

        const limited = new PlacementRouteFixture();
        limited.rateLimiter.deniedBuckets.add('platform-write-account');
        assert.equal((await limited.app.request(`http://ims.test${path()}`, {
            method: 'DELETE',
            headers: bearerHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify({ expectedRevision: 0 })
        })).status, 429);
        assert.ok(limited.rateLimiter.calls.some((call) =>
            call.bucket === 'platform-write-account' &&
            call.key === ACCOUNT_ID && call.limit === 120 &&
            call.windowSeconds === 3600
        ));
    });

test('card placement routes strictly validate geometry and expose create/update CAS DTOs',
    async () => {
        const fixture = new PlacementRouteFixture();
        const created = await fixture.app.request(`http://ims.test${path()}`, {
            method: 'PUT',
            headers: bearerHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify(placementBody(null))
        });
        assert.equal(created.status, 201);
        const createdBody = await created.json() as {
            success: boolean;
            placement: Record<string, unknown>;
        };
        const pinnedAt = String(createdBody.placement.pinnedAt);
        assert.equal(new Date(pinnedAt).toISOString(), pinnedAt);
        assert.deepEqual(createdBody, {
            success: true,
            placement: {
                pinnedAt,
                x: 25.5,
                y: 74.5,
                rotation: -3,
                zIndex: 12,
                revision: 0,
                updatedAt: pinnedAt
            }
        });

        const duplicate = await fixture.app.request(`http://ims.test${path()}`, {
            method: 'PUT',
            headers: bearerHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify(placementBody(null))
        });
        assert.equal(duplicate.status, 409);
        assert.equal((await duplicate.json() as { revision: number }).revision, 0);

        for (const invalid of [
            { ...placementBody(0), x: -0.01 },
            { ...placementBody(0), y: 100.01 },
            { ...placementBody(0), rotation: 12.01 },
            { ...placementBody(0), zIndex: 1.5 },
            { ...placementBody(0), expectedRevision: '0' },
            { ...placementBody(0), expectedRevision: 2_147_483_648 },
            { ...placementBody(0), unexpected: true }
        ]) {
            assert.equal((await fixture.app.request(`http://ims.test${path()}`, {
                method: 'PUT',
                headers: bearerHeaders({ 'content-type': 'application/json' }),
                body: JSON.stringify(invalid)
            })).status, 400);
        }

        const updated = await fixture.app.request(`http://ims.test${path()}`, {
            method: 'PUT',
            headers: bearerHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify({
                x: 0,
                y: 100,
                rotation: 12,
                zIndex: 999,
                expectedRevision: 0
            })
        });
        assert.equal(updated.status, 200);
        const updatedBody = await updated.json() as {
            placement: Record<string, unknown>;
        };
        assert.equal(updatedBody.placement.pinnedAt, pinnedAt);
        assert.equal(updatedBody.placement.revision, 1);
        assert.equal(updatedBody.placement.x, 0);
        assert.equal(updatedBody.placement.y, 100);

        const stale = await fixture.app.request(`http://ims.test${path()}`, {
            method: 'PUT',
            headers: bearerHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify(placementBody(0))
        });
        assert.equal(stale.status, 409);
        assert.deepEqual(await stale.json(), {
            success: false,
            code: 'FUDABA_CARD_PLACEMENT_CONFLICT',
            revision: 1
        });
        assert.equal((await fixture.app.request(`http://ims.test${path('other-card')}`, {
            method: 'PUT',
            headers: bearerHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify(placementBody(null))
        })).status, 404);
        assert.equal((await fixture.app.request(
            `http://ims.test${path('x'.repeat(129))}`,
            {
                method: 'PUT',
                headers: bearerHeaders({ 'content-type': 'application/json' }),
                body: JSON.stringify(placementBody(null))
            }
        )).status, 404);
    });

test('card placement saves hide closed or non-public offices while deletion remains available',
    async () => {
        const notFound = {
            success: false,
            code: 'FUDABA_CARD_PLACEMENT_NOT_FOUND'
        };
        const closed = new PlacementRouteFixture({ officeOpen: false });
        const closedCreate = await closed.app.request(`http://ims.test${path()}`, {
            method: 'PUT',
            headers: bearerHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify(placementBody(null))
        });
        assert.equal(closedCreate.status, 404);
        assert.deepEqual(await closedCreate.json(), notFound);

        const suspendedOwner = new PlacementRouteFixture({
            officeOwnerStatus: 'suspended'
        });
        const suspendedCreate = await suspendedOwner.app.request(
            `http://ims.test${path()}`,
            {
                method: 'PUT',
                headers: bearerHeaders({ 'content-type': 'application/json' }),
                body: JSON.stringify(placementBody(null))
            }
        );
        assert.equal(suspendedCreate.status, 404);
        assert.deepEqual(await suspendedCreate.json(), notFound);

        const fixture = new PlacementRouteFixture();
        assert.equal((await fixture.app.request(`http://ims.test${path()}`, {
            method: 'PUT',
            headers: bearerHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify(placementBody(null))
        })).status, 201);
        fixture.officeOpen = false;
        const closedUpdate = await fixture.app.request(`http://ims.test${path()}`, {
            method: 'PUT',
            headers: bearerHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify(placementBody(0))
        });
        assert.equal(closedUpdate.status, 404);
        assert.deepEqual(await closedUpdate.json(), notFound);

        const removed = await fixture.app.request(`http://ims.test${path()}`, {
            method: 'DELETE',
            headers: bearerHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify({ expectedRevision: 0 })
        });
        assert.equal(removed.status, 200);
        assert.deepEqual(await removed.json(), { success: true, revision: 1 });
    });

test('card placement DELETE enforces CAS, reports in-use state, and advances revision',
    async () => {
        const fixture = new PlacementRouteFixture();
        assert.equal((await fixture.app.request(`http://ims.test${path()}`, {
            method: 'PUT',
            headers: bearerHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify(placementBody(null))
        })).status, 201);

        const stale = await fixture.app.request(`http://ims.test${path()}`, {
            method: 'DELETE',
            headers: bearerHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify({ expectedRevision: 2 })
        });
        assert.equal(stale.status, 409);
        assert.equal((await stale.json() as { revision: number }).revision, 0);
        assert.equal((await fixture.app.request(`http://ims.test${path()}`, {
            method: 'DELETE',
            headers: bearerHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify({ expectedRevision: '0' })
        })).status, 400);

        fixture.inUse = true;
        const inUse = await fixture.app.request(`http://ims.test${path()}`, {
            method: 'DELETE',
            headers: bearerHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify({ expectedRevision: 0 })
        });
        assert.equal(inUse.status, 409);
        assert.deepEqual(await inUse.json(), {
            success: false,
            code: 'FUDABA_CARD_PLACEMENT_IN_USE',
            revision: 0
        });

        fixture.inUse = false;
        const removed = await fixture.app.request(`http://ims.test${path()}`, {
            method: 'DELETE',
            headers: {
                ...cookieHeaders(true),
                'content-type': 'application/json'
            },
            body: JSON.stringify({ expectedRevision: 0 })
        });
        assert.equal(removed.status, 200);
        assert.deepEqual(await removed.json(), { success: true, revision: 1 });
        assert.equal((await fixture.app.request(`http://ims.test${path()}`, {
            method: 'DELETE',
            headers: bearerHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify({ expectedRevision: 1 })
        })).status, 404);
    });
