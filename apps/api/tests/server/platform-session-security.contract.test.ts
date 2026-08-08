import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { sign, verify } from 'hono/utils/jwt/jwt';
import { createHonoApp } from '@/app';
import { SqlPlatformAccountRepository } from '@/infra/db/repositories/platform-account-repository';
import { HmacBackofficeTokenService } from '@/infra/security/hmac/token-service';
import { PostgresConnection } from '@/infra/db/postgresql/connection';
import type { ManagedSqlDatabase, SqlSchemaStrategy } from '@/infra/db/sql/database';
import type { NewPlatformAccountInput, PlatformAccountStatus } from '@/ports/repositories';
import type { RuntimeServices } from '@/ports/runtime-services';
import { sha256Hex } from '@/utils/crypto/sha256';
import {
    createPostgresTestHarness,
    postgresIntegrationEnabled
} from '../integration/postgres-harness';

const PLATFORM_SECRET = 'shared-realm-test-secret-at-least-thirty-two-bytes';
const ACCESS_COOKIE = 'ims_platform_access';
const REFRESH_COOKIE = 'ims_platform_refresh';
const CSRF_COOKIE = 'ims_platform_csrf';
const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const textEncoder = new TextEncoder();

interface PlatformClaims extends Record<string, unknown> {
    iss: 'imsweb';
    aud: 'ims-platform';
    kind: 'platform';
    id: string;
    tokenVersion: number;
    sessionId: string;
    csrfSecret: string;
    jti: string;
    iat: number;
    exp: number;
}

interface SeededSession {
    accountId: string;
    sessionId: string;
    accessToken: string;
    refreshToken: string;
    csrfSecret: string;
    cookies: Map<string, string>;
    expiresAt: number;
}

interface Fixture {
    app: ReturnType<typeof createHonoApp>;
    database: ManagedSqlDatabase;
    databaseUrl?: string;
    platformTokens: TestPlatformTokenService;
    repository: SqlPlatformAccountRepository;
    seedSession(options?: {
        accountId?: string;
        sessionId?: string;
        status?: PlatformAccountStatus;
        tokenVersion?: number;
        expiresAt?: number;
    }): Promise<SeededSession>;
    close(): Promise<void>;
}

const initializedPostgresSchema: SqlSchemaStrategy = {
    initializeCore: async () => undefined,
    initializePlatform: async () => undefined,
    initializeFudaba: async () => undefined,
    initializeStory: async () => undefined
};

class TestPlatformTokenService {
    constructor(private readonly secret: string) {}

    async sign(
        input: Omit<PlatformClaims, 'iss' | 'aud' | 'kind' | 'jti' | 'iat' | 'exp'>,
        expiresInSeconds: number
    ): Promise<string> {
        const iat = Math.floor(Date.now() / 1000);
        return sign({
            ...input,
            iss: 'imsweb',
            aud: 'ims-platform',
            kind: 'platform',
            jti: randomUUID(),
            iat,
            exp: iat + expiresInSeconds
        }, this.secret, 'HS256');
    }

    async verify(token: string): Promise<PlatformClaims> {
        const payload = await verify(token, this.secret, 'HS256');
        if (
            payload.iss !== 'imsweb' || payload.aud !== 'ims-platform' ||
            payload.kind !== 'platform' || typeof payload.id !== 'string' ||
            typeof payload.tokenVersion !== 'number' ||
            typeof payload.sessionId !== 'string' ||
            typeof payload.csrfSecret !== 'string' || typeof payload.jti !== 'string' ||
            typeof payload.iat !== 'number' || typeof payload.exp !== 'number' ||
            payload.exp <= Math.floor(Date.now() / 1000)
        ) {
            throw new Error('Invalid Platform JWT claims');
        }
        return payload as PlatformClaims;
    }
}

function setCookies(response: Response): string[] {
    return (response.headers as Headers & { getSetCookie(): string[] }).getSetCookie();
}

function cookieValues(response: Response): Map<string, string> {
    return new Map(setCookies(response).map((cookie) => {
        const [pair] = cookie.split(';', 1);
        const separator = pair!.indexOf('=');
        return [pair!.slice(0, separator), decodeURIComponent(pair!.slice(separator + 1))];
    }));
}

function cookieHeader(values: Map<string, string>): string {
    return [...values].map(([name, value]) => (
        `${name}=${encodeURIComponent(value)}`
    )).join('; ');
}

function assertClearedPlatformCookies(response: Response): void {
    const cookies = setCookies(response);
    assert.deepEqual(
        cookies.map((cookie) => cookie.split('=', 1)[0]).sort(),
        [ACCESS_COOKIE, CSRF_COOKIE, REFRESH_COOKIE]
    );
    for (const cookie of cookies) {
        assert.match(cookie, /Max-Age=0/i);
        assert.match(cookie, /SameSite=Lax/i);
        if (cookie.startsWith(`${REFRESH_COOKIE}=`)) {
            assert.match(cookie, /Path=\/api\/platform\/auth/i);
        } else {
            assert.match(cookie, /Path=\//i);
        }
    }
}

function hashSecret(value: string): Promise<string> {
    return sha256Hex(textEncoder.encode(value));
}

function jwtPart(token: string, index: number): Record<string, unknown> {
    const part = token.split('.')[index];
    if (!part) throw new Error('JWT part is missing');
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function expectedSessionPayload(accountId: string, status: PlatformAccountStatus) {
    return {
        success: true,
        account: { id: accountId, status },
        profile: {
            displayName: `Producer ${accountId}`,
            avatarUrl: `https://avatars.example.test/${accountId}.png`,
            homeCity: 'Shanghai',
            bio: `Profile ${accountId}`
        }
    };
}

async function createFixture(
    t: TestContext,
    dialect: 'sqlite' | 'postgresql' = 'postgresql'
): Promise<Fixture> {
    const harness = await createPostgresTestHarness();
    const database = harness.connection;
    const repository = new SqlPlatformAccountRepository(
        database,
        initializedPostgresSchema
    );
    await repository.initialize();
    const platformTokens = new TestPlatformTokenService(PLATFORM_SECRET);
    const runtime = {
        platformAccounts: repository,
        platformTokens,
        backofficeTokens: new HmacBackofficeTokenService(PLATFORM_SECRET),
        config: {
            cookieSecure: false,
            clientAddressSource: 'nginx'
        }
    } as unknown as RuntimeServices;
    const app = createHonoApp(() => runtime);
    let closed = false;
    const fixture: Fixture = {
        app,
        database,
        databaseUrl: harness.databaseUrl,
        platformTokens,
        repository,
        async seedSession(options = {}) {
            const now = Date.now();
            const accountId = options.accountId ?? `platform-${randomUUID()}`;
            const sessionId = options.sessionId ?? `session-${randomUUID()}`;
            const status = options.status ?? 'active';
            const tokenVersion = options.tokenVersion ?? 0;
            const deletedAt = status === 'deleted' ? now : null;
            const account: NewPlatformAccountInput = {
                id: accountId,
                status,
                tokenVersion,
                createdAt: now,
                updatedAt: now,
                deletedAt,
                profile: {
                    displayName: `Producer ${accountId}`,
                    avatarObjectKey: null,
                    avatarExternalUrl: `https://avatars.example.test/${accountId}.png`,
                    homeCity: 'Shanghai',
                    bio: `Profile ${accountId}`,
                    updatedAt: now
                }
            };
            await repository.createAccountWithProfile(account);
            const refreshToken = `refresh-${randomUUID()}-${randomUUID()}`;
            const csrfSecret = `csrf-${randomUUID()}-${randomUUID()}`;
            const expiresAt = options.expiresAt ?? now + 60 * 60 * 1000;
            await database.prepare(
                `INSERT INTO platform_refresh_sessions
                    (id, account_id, token_hash, previous_token_hash, csrf_hash,
                     expires_at, created_at, updated_at, revoked_at)
                 VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL)`
            ).bind(
                sessionId,
                accountId,
                await hashSecret(refreshToken),
                await hashSecret(csrfSecret),
                expiresAt,
                now,
                now
            ).run();
            await database.prepare(
                `INSERT INTO platform_security_events
                    (id, account_id, event_type, request_id, ip_address,
                     user_agent, metadata_json, created_at)
                 VALUES (?, ?, 'auth.session.created', ?, ?, ?, '{}', ?)`
            ).bind(
                `event-${randomUUID()}`,
                accountId,
                `fixture-${randomUUID()}`,
                '127.0.0.1',
                'platform-session-contract-fixture',
                now
            ).run();
            const accessToken = await platformTokens.sign({
                id: accountId,
                tokenVersion,
                sessionId,
                csrfSecret
            }, ACCESS_TTL_SECONDS);
            return {
                accountId,
                sessionId,
                accessToken,
                refreshToken,
                csrfSecret,
                expiresAt,
                cookies: new Map([
                    [ACCESS_COOKIE, accessToken],
                    [REFRESH_COOKIE, refreshToken],
                    [CSRF_COOKIE, csrfSecret]
                ])
            };
        },
        async close() {
            if (closed) return;
            closed = true;
            await harness.close();
        }
    };
    t.after(() => fixture.close());
    return fixture;
}

async function sessionRequest(fixture: Fixture, cookies: Map<string, string>): Promise<Response> {
    return fixture.app.request('http://ims.test/api/platform/auth/session', {
        headers: { Cookie: cookieHeader(cookies) }
    });
}

async function refreshRequest(
    fixture: Fixture,
    cookies: Map<string, string>,
    csrf?: string
): Promise<Response> {
    return fixture.app.request('http://ims.test/api/platform/auth/refresh', {
        method: 'POST',
        headers: {
            Cookie: cookieHeader(cookies),
            ...(csrf ? { 'X-CSRFToken': csrf } : {}),
            'X-Request-ID': `request-${randomUUID()}`,
            'X-Forwarded-For': '127.0.0.8',
            'User-Agent': `platform-contract/${'u'.repeat(1100)}`
        }
    });
}

async function sessionRow(fixture: Fixture, sessionId: string) {
    return fixture.database.prepare(
        `SELECT token_hash, previous_token_hash, csrf_hash, expires_at, revoked_at
         FROM platform_refresh_sessions WHERE id=?`
    ).bind(sessionId).first<{
        token_hash: string;
        previous_token_hash: string | null;
        csrf_hash: string;
        expires_at: number;
        revoked_at: number | null;
    }>();
}

async function eventRows(fixture: Fixture, accountId: string) {
    const result = await fixture.database.prepare(
        `SELECT event_type, request_id, ip_address, user_agent, metadata_json
         FROM platform_security_events WHERE account_id=? ORDER BY created_at, event_type`
    ).bind(accountId).all<{
        event_type: string;
        request_id: string | null;
        ip_address: string | null;
        user_agent: string | null;
        metadata_json: string;
    }>();
    return result.results;
}

test('Platform session authenticates active and restricted accounts through a live family', async (t) => {
    const fixture = await createFixture(t);
    const active = await fixture.seedSession({ accountId: 'platform-active' });

    const anonymous = await fixture.app.request(
        'http://ims.test/api/platform/auth/session'
    );
    assert.equal(anonymous.status, 401);
    assert.deepEqual(await anonymous.json(), {
        success: false,
        code: 'PLATFORM_SESSION_INVALID'
    });

    const authenticated = await sessionRequest(fixture, active.cookies);
    assert.equal(authenticated.status, 200);
    assert.deepEqual(await authenticated.json(), expectedSessionPayload(active.accountId, 'active'));

    await fixture.database.prepare(
        "UPDATE platform_accounts SET status='restricted', updated_at=? WHERE id=?"
    ).bind(Date.now(), active.accountId).run();
    const restricted = await sessionRequest(fixture, active.cookies);
    assert.equal(restricted.status, 200);
    assert.deepEqual(
        await restricted.json(),
        expectedSessionPayload(active.accountId, 'restricted')
    );
    const restrictedRefresh = await refreshRequest(
        fixture,
        active.cookies,
        active.csrfSecret
    );
    assert.equal(restrictedRefresh.status, 200);
    assert.deepEqual(
        await restrictedRefresh.clone().json(),
        expectedSessionPayload(active.accountId, 'restricted')
    );

    await fixture.database.prepare(
        'UPDATE platform_accounts SET token_version=token_version+1, updated_at=? WHERE id=?'
    ).bind(Date.now(), active.accountId).run();
    assert.equal(
        (await sessionRequest(fixture, cookieValues(restrictedRefresh))).status,
        401
    );

    const revoked = await fixture.seedSession({ accountId: 'platform-revoked' });
    await fixture.database.prepare(
        'UPDATE platform_refresh_sessions SET revoked_at=?, updated_at=? WHERE id=?'
    ).bind(Date.now(), Date.now(), revoked.sessionId).run();
    assert.equal((await sessionRequest(fixture, revoked.cookies)).status, 401);

    const expired = await fixture.seedSession({ accountId: 'platform-expired' });
    const past = Date.now() - 1_000;
    await fixture.database.prepare(
        `UPDATE platform_refresh_sessions
         SET created_at=?, updated_at=?, expires_at=? WHERE id=?`
    ).bind(past - 60_000, past - 60_000, past, expired.sessionId).run();
    assert.equal((await sessionRequest(fixture, expired.cookies)).status, 401);
});

test('refresh-session writes fence the current account token version atomically', async (t) => {
    const fixture = await createFixture(t);
    const seeded = await fixture.seedSession({ accountId: 'platform-version-fence' });
    const now = Date.now();
    const event = (id: string) => ({
        id: `event-${id}`,
        accountId: seeded.accountId,
        eventType: 'auth.session.created' as const,
        requestId: null,
        ipAddress: null,
        userAgent: null,
        metadataJson: '{}',
        createdAt: now
    });
    assert.equal(await fixture.repository.createRefreshSession({
        id: 'version-fence-rejected',
        accountId: seeded.accountId,
        accountTokenVersion: 1,
        tokenHash: 'a'.repeat(64),
        csrfHash: 'b'.repeat(64),
        expiresAt: now + 60_000,
        createdAt: now,
        event: event('rejected')
    }), false);
    assert.equal(await fixture.repository.findRefreshSessionById(
        'version-fence-rejected'
    ), null);

    assert.equal(await fixture.repository.createRefreshSession({
        id: 'version-fence-created',
        accountId: seeded.accountId,
        accountTokenVersion: 0,
        tokenHash: 'c'.repeat(64),
        csrfHash: 'd'.repeat(64),
        expiresAt: now + 60_000,
        createdAt: now,
        event: event('created')
    }), true);
    await fixture.database.prepare(
        'UPDATE platform_accounts SET token_version=1, updated_at=? WHERE id=?'
    ).bind(now + 1, seeded.accountId).run();
    assert.equal(await fixture.repository.rotateRefreshSession({
        id: 'version-fence-created',
        accountTokenVersion: 0,
        currentTokenHash: 'c'.repeat(64),
        nextTokenHash: 'e'.repeat(64),
        nextCsrfHash: 'f'.repeat(64),
        nextExpiresAt: now + 120_000,
        updatedAt: now + 1,
        event: {
            ...event('rotate'),
            eventType: 'auth.refresh.succeeded'
        }
    }), false);
    assert.equal(
        (await fixture.repository.findRefreshSessionById(
            'version-fence-created'
        ))?.token_hash,
        'c'.repeat(64)
    );
});

test('Platform and Backoffice reject each other even when their test secret is shared', async (t) => {
    const fixture = await createFixture(t);
    const session = await fixture.seedSession({ accountId: 'platform-realm' });
    const backofficeTokens = new HmacBackofficeTokenService(PLATFORM_SECRET);
    const backofficeToken = await backofficeTokens.sign({
        id: 42,
        username: 'realm-op',
        producername: 'Realm Op',
        dept: 'op',
        adminRole: 'admin',
        csrfSecret: 'backoffice-csrf'
    }, ACCESS_TTL_SECONDS);
    const platformAtBackoffice = await fixture.app.request(
        'http://ims.test/api/admin/auth/session',
        { headers: { Cookie: `ims_admin_access=${encodeURIComponent(session.accessToken)}` } }
    );
    assert.equal(platformAtBackoffice.status, 401);

    const backofficeAtPlatform = await fixture.app.request(
        'http://ims.test/api/platform/auth/session',
        { headers: { Cookie: `${ACCESS_COOKIE}=${encodeURIComponent(backofficeToken)}` } }
    );
    assert.equal(backofficeAtPlatform.status, 401);

    const now = Math.floor(Date.now() / 1000);
    const missingAudience = await sign({
        iss: 'imsweb',
        kind: 'platform',
        id: session.accountId,
        tokenVersion: 0,
        sessionId: session.sessionId,
        csrfSecret: session.csrfSecret,
        jti: randomUUID(),
        iat: now,
        exp: now + ACCESS_TTL_SECONDS
    }, PLATFORM_SECRET, 'HS256');
    const realmLess = new Map(session.cookies);
    realmLess.set(ACCESS_COOKIE, missingAudience);
    assert.equal((await sessionRequest(fixture, realmLess)).status, 401);
});

test('production Platform token service fixes HS256 and all realm/session claims', async () => {
    const moduleId = pathToFileURL(path.join(
        __dirname,
        '../../src/infra/security/hmac/platform-token-service.ts'
    )).href;
    const tokenModule = await import(moduleId) as {
        HmacPlatformTokenService?: new (secret: string) => {
            sign(input: {
                id: string;
                tokenVersion: number;
                sessionId: string;
                csrfSecret: string;
            }, expiresInSeconds: number): Promise<string>;
            verify(token: string): Promise<PlatformClaims>;
        };
    };
    assert.equal(typeof tokenModule.HmacPlatformTokenService, 'function');
    const service = new tokenModule.HmacPlatformTokenService!(PLATFORM_SECRET);
    const token = await service.sign({
        id: 'platform-token-contract',
        tokenVersion: 7,
        sessionId: 'session-token-contract',
        csrfSecret: 'csrf-token-contract'
    }, ACCESS_TTL_SECONDS);
    assert.equal(jwtPart(token, 0).alg, 'HS256');
    assert.deepEqual(
        await service.verify(token),
        jwtPart(token, 1) as unknown as PlatformClaims
    );

    const now = Math.floor(Date.now() / 1000);
    const invalidPayloads = [
        {
            iss: 'imsweb', aud: 'ims-backoffice', kind: 'backoffice', id: 7,
            tokenVersion: 7, sessionId: 'session-token-contract',
            csrfSecret: 'csrf-token-contract', jti: randomUUID(), iat: now,
            exp: now + ACCESS_TTL_SECONDS
        },
        {
            iss: 'imsweb', kind: 'platform', id: 'platform-token-contract',
            tokenVersion: 7, sessionId: 'session-token-contract',
            csrfSecret: 'csrf-token-contract', jti: randomUUID(), iat: now,
            exp: now + ACCESS_TTL_SECONDS
        }
    ];
    for (const payload of invalidPayloads) {
        const invalid = await sign(payload, PLATFORM_SECRET, 'HS256');
        await assert.rejects(service.verify(invalid));
    }
    const wrongAlgorithm = await sign({
        iss: 'imsweb', aud: 'ims-platform', kind: 'platform',
        id: 'platform-token-contract', tokenVersion: 7,
        sessionId: 'session-token-contract', csrfSecret: 'csrf-token-contract',
        jti: randomUUID(), iat: now, exp: now + ACCESS_TTL_SECONDS
    }, PLATFORM_SECRET, 'HS512');
    await assert.rejects(service.verify(wrongAlgorithm));
});

test('Platform refresh requires cookie, header, and stored CSRF before rotating state', async (t) => {
    const fixture = await createFixture(t);
    const session = await fixture.seedSession({ accountId: 'platform-csrf' });
    const before = await sessionRow(fixture, session.sessionId);
    assert.ok(before);

    const missing = await refreshRequest(fixture, session.cookies);
    assert.equal(missing.status, 403);
    assert.deepEqual(await missing.json(), {
        success: false,
        code: 'PLATFORM_CSRF_INVALID'
    });
    assert.deepEqual(await sessionRow(fixture, session.sessionId), before);

    const mismatch = await refreshRequest(fixture, session.cookies, 'not-the-cookie-value');
    assert.equal(mismatch.status, 403);
    assert.deepEqual(await sessionRow(fixture, session.sessionId), before);

    const forged = new Map(session.cookies);
    forged.set(CSRF_COOKIE, 'matching-header-but-not-stored');
    const storedMismatch = await refreshRequest(
        fixture,
        forged,
        'matching-header-but-not-stored'
    );
    assert.equal(storedMismatch.status, 403);
    assert.deepEqual(await sessionRow(fixture, session.sessionId), before);
});

async function assertRotationReplayAndLogout(
    t: TestContext,
    dialect: 'sqlite' | 'postgresql'
): Promise<void> {
    const fixture = await createFixture(t, dialect);
    const session = await fixture.seedSession({ accountId: `${dialect}-rotation` });
    const other = await fixture.seedSession({ accountId: `${dialect}-other-family` });
    const concurrent = await fixture.seedSession({
        accountId: `${dialect}-concurrent-cas`
    });

    const concurrentResponses = await Promise.all([
        refreshRequest(fixture, concurrent.cookies, concurrent.csrfSecret),
        refreshRequest(fixture, concurrent.cookies, concurrent.csrfSecret)
    ]);
    assert.deepEqual(
        concurrentResponses.map((response) => response.status).sort(),
        [200, 401]
    );
    assert.ok((await sessionRow(fixture, concurrent.sessionId))?.revoked_at);

    const refreshed = await refreshRequest(fixture, session.cookies, session.csrfSecret);
    assert.equal(refreshed.status, 200);
    assert.deepEqual(
        await refreshed.clone().json(),
        expectedSessionPayload(session.accountId, 'active')
    );
    const refreshedCookies = cookieValues(refreshed);
    assert.deepEqual([...refreshedCookies.keys()].sort(), [
        ACCESS_COOKIE,
        CSRF_COOKIE,
        REFRESH_COOKIE
    ]);
    assert.notEqual(refreshedCookies.get(ACCESS_COOKIE), session.accessToken);
    assert.notEqual(refreshedCookies.get(REFRESH_COOKIE), session.refreshToken);
    assert.notEqual(refreshedCookies.get(CSRF_COOKIE), session.csrfSecret);
    for (const cookie of setCookies(refreshed)) {
        assert.match(cookie, /SameSite=Lax/i);
        if (cookie.startsWith(`${REFRESH_COOKIE}=`)) {
            assert.match(cookie, /HttpOnly/i);
            assert.match(cookie, /Path=\/api\/platform\/auth/i);
            assert.match(cookie, /Max-Age=2592000/i);
        } else if (cookie.startsWith(`${ACCESS_COOKIE}=`)) {
            assert.match(cookie, /HttpOnly/i);
            assert.match(cookie, /Path=\//i);
            assert.match(cookie, /Max-Age=900/i);
        } else {
            assert.match(cookie, /Path=\//i);
            assert.doesNotMatch(cookie, /HttpOnly/i);
            assert.match(cookie, /Max-Age=2592000/i);
        }
        assert.doesNotMatch(cookie, /;\s*Secure/i);
    }

    const rotated = await sessionRow(fixture, session.sessionId);
    assert.ok(rotated);
    assert.equal(rotated.previous_token_hash, await hashSecret(session.refreshToken));
    assert.equal(
        rotated.token_hash,
        await hashSecret(refreshedCookies.get(REFRESH_COOKIE)!)
    );
    assert.equal(rotated.csrf_hash, await hashSecret(refreshedCookies.get(CSRF_COOKIE)!));
    assert.ok(rotated.expires_at >= Date.now() + REFRESH_TTL_MS - 10_000);
    assert.equal(rotated.revoked_at, null);

    const access = refreshedCookies.get(ACCESS_COOKIE)!;
    assert.deepEqual(jwtPart(access, 0), { alg: 'HS256', typ: 'JWT' });
    const claims = jwtPart(access, 1);
    assert.equal(claims.iss, 'imsweb');
    assert.equal(claims.aud, 'ims-platform');
    assert.equal(claims.kind, 'platform');
    assert.equal(claims.id, session.accountId);
    assert.equal(claims.tokenVersion, 0);
    assert.equal(claims.sessionId, session.sessionId);
    assert.equal(claims.csrfSecret, refreshedCookies.get(CSRF_COOKIE));
    assert.equal(typeof claims.jti, 'string');
    assert.equal(Number(claims.exp) - Number(claims.iat), ACCESS_TTL_SECONDS);

    const replay = await refreshRequest(fixture, session.cookies, session.csrfSecret);
    assert.equal(replay.status, 401);
    assertClearedPlatformCookies(replay);
    assert.ok((await sessionRow(fixture, session.sessionId))?.revoked_at);
    assert.equal((await sessionRow(fixture, other.sessionId))?.revoked_at, null);
    assert.equal((await sessionRequest(fixture, other.cookies)).status, 200);

    const logoutCookies = new Map(other.cookies);
    logoutCookies.set('ims_admin_access', 'backoffice-access-must-survive');
    logoutCookies.set('ims_admin_refresh', 'backoffice-refresh-must-survive');
    logoutCookies.set('ims_admin_csrf', 'backoffice-csrf-must-survive');
    const logout = await fixture.app.request('http://ims.test/api/platform/auth/logout', {
        method: 'POST',
        headers: {
            Cookie: cookieHeader(logoutCookies),
            'X-CSRFToken': other.csrfSecret,
            'X-Request-ID': `logout-${randomUUID()}`
        }
    });
    assert.equal(logout.status, 200);
    assert.deepEqual(await logout.clone().json(), { success: true });
    assertClearedPlatformCookies(logout);
    assert.equal((await sessionRequest(fixture, other.cookies)).status, 401);

    const events = await eventRows(fixture, session.accountId);
    assert.equal(events.length, 3);
    assert.deepEqual(new Set(events.map((event) => event.event_type)), new Set([
        'auth.session.created',
        'auth.refresh.succeeded',
        'auth.refresh.replay'
    ]));
    const serialized = JSON.stringify(events);
    assert.equal(serialized.includes(session.refreshToken), false);
    assert.equal(serialized.includes(session.csrfSecret), false);
    assert.equal(serialized.includes(session.accessToken), false);
    for (const event of events.filter((item) => item.event_type !== 'auth.session.created')) {
        assert.ok((event.user_agent?.length ?? 0) <= 1024);
        assert.doesNotMatch(
            event.metadata_json,
            /"(?:access_token|refresh_token|csrf_secret|oauth_access_token|oauth_refresh_token)"\s*:/i
        );
    }
    const otherEvents = await eventRows(fixture, other.accountId);
    assert.equal(otherEvents.length, 2);
    assert.deepEqual(
        new Set(otherEvents.map((event) => event.event_type)),
        new Set(['auth.session.created', 'auth.logout'])
    );
}

test('suspended and deleted Platform accounts are blocked and their family is revoked', async (t) => {
    const fixture = await createFixture(t);
    for (const status of ['suspended', 'deleted'] as const) {
        const session = await fixture.seedSession({
            accountId: `platform-${status}`,
            status
        });
        const response = status === 'suspended'
            ? await refreshRequest(fixture, session.cookies, session.csrfSecret)
            : await sessionRequest(fixture, session.cookies);
        assert.equal(response.status, 403);
        assert.deepEqual(await response.json(), {
            success: false,
            code: status === 'suspended'
                ? 'PLATFORM_ACCOUNT_SUSPENDED'
                : 'PLATFORM_ACCOUNT_UNAVAILABLE'
        });
        assert.ok((await sessionRow(fixture, session.sessionId))?.revoked_at);
        const events = await eventRows(fixture, session.accountId);
        assert.equal(events.length, 2);
        assert.deepEqual(
            new Set(events.map((event) => event.event_type)),
            new Set(['auth.session.created', 'auth.account_blocked'])
        );
    }
});

test('Platform refresh has a dedicated 120 per 15 minute rate-limit bucket', async () => {
    const calls: Array<{
        bucket: string;
        limit: number;
        windowSeconds: number;
    }> = [];
    const app = createHonoApp(() => ({
        rateLimiter: {
            async consume(bucket, _key, limit, windowSeconds) {
                calls.push({ bucket, limit, windowSeconds });
                return { allowed: true, remaining: limit - 1, resetAt: Date.now() + 60_000 };
            }
        }
    }));
    const response = await app.request('http://ims.test/api/platform/auth/refresh', {
        method: 'POST'
    });
    assert.deepEqual(calls, [
        { bucket: 'global', limit: 10_000, windowSeconds: 15 * 60 },
        { bucket: 'platform-auth-refresh', limit: 120, windowSeconds: 15 * 60 }
    ]);
    assert.equal(response.status, 401);
});

test('Platform logout is idempotent and Bearer authentication does not require CSRF', async (t) => {
    const fixture = await createFixture(t);
    const session = await fixture.seedSession({ accountId: 'platform-bearer-logout' });
    const bearerLogout = await fixture.app.request(
        'http://ims.test/api/platform/auth/logout',
        {
            method: 'POST',
            headers: { Authorization: `Bearer ${session.accessToken}` }
        }
    );
    assert.equal(bearerLogout.status, 200);
    assert.ok((await sessionRow(fixture, session.sessionId))?.revoked_at);

    const anonymousLogout = await fixture.app.request(
        'http://ims.test/api/platform/auth/logout',
        { method: 'POST' }
    );
    assert.equal(anonymousLogout.status, 200);
    assert.deepEqual(await anonymousLogout.clone().json(), { success: true });
    assertClearedPlatformCookies(anonymousLogout);
});

test('real PostgreSQL enforces Platform rotation, replay, logout, and event behavior', {
    skip: !postgresIntegrationEnabled() &&
        'set IMS_TEST_POSTGRES_ADMIN_URL to a local PostgreSQL admin database'
}, async (t) => {
    await assertRotationReplayAndLogout(t, 'postgresql');
});

test('real PostgreSQL emits refresh success only for the cross-instance CAS winner', {
    skip: !postgresIntegrationEnabled() &&
        'set IMS_TEST_POSTGRES_ADMIN_URL to a local PostgreSQL admin database'
}, async (t) => {
    const fixture = await createFixture(t, 'postgresql');
    assert.ok(fixture.databaseUrl);
    const session = await fixture.seedSession({ accountId: 'postgresql-cross-instance-cas' });

    await fixture.database.executeScript(`
        CREATE OR REPLACE FUNCTION imsweb_test_delay_platform_refresh_success()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
            PERFORM pg_sleep(0.25);
            RETURN NEW;
        END;
        $$;

        CREATE TRIGGER imsweb_test_delay_platform_refresh_success
        BEFORE INSERT ON platform_security_events
        FOR EACH ROW
        WHEN (NEW.event_type = 'auth.refresh.succeeded')
        EXECUTE FUNCTION imsweb_test_delay_platform_refresh_success();
    `);

    const siblingDatabase = PostgresConnection.create({
        connectionString: fixture.databaseUrl,
        maxConnections: 2,
        idleTimeoutMs: 5_000,
        connectionTimeoutMs: 5_000,
        statementTimeoutMs: 30_000,
        idleInTransactionTimeoutMs: 30_000
    });
    try {
        const siblingRepository = new SqlPlatformAccountRepository(
            siblingDatabase,
            initializedPostgresSchema
        );
        await siblingRepository.initialize();
        const siblingRuntime = {
            platformAccounts: siblingRepository,
            platformTokens: fixture.platformTokens,
            backofficeTokens: new HmacBackofficeTokenService(PLATFORM_SECRET),
            config: {
                cookieSecure: false,
                clientAddressSource: 'nginx'
            }
        } as unknown as RuntimeServices;
        const siblingFixture = {
            ...fixture,
            app: createHonoApp(() => siblingRuntime)
        };

        const responses = await Promise.all([
            refreshRequest(fixture, session.cookies, session.csrfSecret),
            refreshRequest(siblingFixture, session.cookies, session.csrfSecret)
        ]);
        assert.deepEqual(
            responses.map((response) => response.status).sort(),
            [200, 401]
        );
        assert.ok((await sessionRow(fixture, session.sessionId))?.revoked_at);

        const events = await eventRows(fixture, session.accountId);
        assert.equal(
            events.filter((event) => event.event_type === 'auth.refresh.succeeded').length,
            1
        );
        assert.equal(
            events.filter((event) => event.event_type === 'auth.refresh.replay').length,
            1
        );
    } finally {
        await siblingDatabase.close();
    }
});
