import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { sign as signJwt } from 'hono/utils/jwt/jwt';
import { createHonoApp } from '@/app';
import { hashBackofficeAuthSecret } from '@/domains/backoffice-auth/backoffice-auth-session';
import { SqlCoreRepository } from '@/infra/db/repositories/core-repository';
import { PostgresConnection } from '@/infra/db/postgresql/connection';
import { PostgresqlSchemaStrategy } from '@/infra/db/postgresql/schema-strategy';
import { HmacBackofficeTokenService } from '@/infra/security/hmac/token-service';
import type { RuntimeServices } from '@/ports/runtime-services';
import { createPostgresTestDatabase } from './postgres-test-database';

const USERNAME = 'backoffice-boundary-op';
const PASSWORD = 'backoffice-boundary-password';
const SECRET = 'backoffice-boundary-secret-at-least-thirty-two-bytes';
const LEGACY_SECRET = 'legacy-backoffice-secret-at-least-thirty-two-bytes';
const ACCESS_COOKIE = 'ims_admin_access';
const REFRESH_COOKIE = 'ims_admin_refresh';
const CSRF_COOKIE = 'ims_admin_csrf';
const LEGACY_SUCCESSORS = new Map([
    ['/api/login', '/api/admin/auth/login'],
    ['/api/admin/login', '/api/admin/auth/login'],
    ['/api/check', '/api/admin/auth/session'],
    ['/api/refresh', '/api/admin/auth/refresh'],
    ['/api/logout', '/api/admin/auth/logout']
]);

interface Fixture {
    app: ReturnType<typeof createHonoApp>;
    connection: PostgresConnection;
    repository: SqlCoreRepository;
    tokens: HmacBackofficeTokenService;
    close(): Promise<void>;
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
    return [...values]
        .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
        .join('; ');
}

function jwtPart(token: string, index: number): Record<string, unknown> {
    const part = token.split('.')[index];
    if (!part) throw new Error(`JWT part ${index} is missing`);
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function assertCanonicalCookies(
    response: Response,
    cleared = false,
    legacyCleared = false
): Map<string, string> {
    const cookies = setCookies(response);
    const byName = new Map(cookies.map((cookie) => [cookie.split('=', 1)[0]!, cookie]));
    const canonicalNames = [ACCESS_COOKIE, CSRF_COOKIE, REFRESH_COOKIE];
    const legacyNames = ['csrf_token', 'refresh_token', 'token'];
    assert.deepEqual(
        [...byName.keys()].sort(),
        [...canonicalNames, ...(legacyCleared ? legacyNames : [])].sort()
    );
    for (const name of [ACCESS_COOKIE, CSRF_COOKIE, REFRESH_COOKIE]) {
        assert.match(byName.get(name)!, /SameSite=Lax/i, `${name} must use SameSite=Lax`);
        if (cleared) assert.match(byName.get(name)!, /Max-Age=0/i, `${name} must be cleared`);
    }
    assert.match(byName.get(ACCESS_COOKIE)!, /; HttpOnly/i);
    assert.match(byName.get(REFRESH_COOKIE)!, /; HttpOnly/i);
    assert.doesNotMatch(byName.get(CSRF_COOKIE)!, /; HttpOnly/i);
    assert.match(byName.get(ACCESS_COOKIE)!, /Path=\//i);
    assert.match(byName.get(CSRF_COOKIE)!, /Path=\//i);
    assert.match(byName.get(REFRESH_COOKIE)!, /Path=\/api/i);
    if (legacyCleared) {
        for (const name of legacyNames) {
            assert.match(byName.get(name)!, /Max-Age=0/i, `${name} must be cleared`);
        }
    }
    return new Map(
        [...cookieValues(response)].filter(([name]) => canonicalNames.includes(name))
    );
}

function assertDeprecated(response: Response, pathName: string): void {
    assert.equal(response.headers.get('Deprecation'), 'true');
    assert.equal(
        response.headers.get('Link'),
        `<${LEGACY_SUCCESSORS.get(pathName)}>; rel="successor-version"`,
        `${pathName} must identify its canonical successor`
    );
}

async function createFixture(
    t: TestContext,
    legacySecret: string | null = LEGACY_SECRET
): Promise<Fixture> {
    const connection = await createPostgresTestDatabase(t, 'backoffice-boundary');
    const repository = new SqlCoreRepository(connection, new PostgresqlSchemaStrategy());
    await repository.initialize();
    await connection.prepare(
        `INSERT INTO backoffice_accounts
            (username, password, dept, producername, admin_role)
         VALUES (?, 'backoffice-boundary-digest', 'op', 'Boundary Producer', 'admin')`
    ).bind(USERNAME).run();
    const tokens = new HmacBackofficeTokenService(SECRET, legacySecret ?? undefined);
    const runtime: RuntimeServices = {
        backofficeAuth: repository,
        audit: repository,
        passwords: {
            async verify(value, digest) {
                return value === PASSWORD && digest === 'backoffice-boundary-digest';
            }
        },
        backofficeTokens: tokens,
        config: { cookieSecure: false }
    };
    return {
        app: createHonoApp(() => runtime),
        connection,
        repository,
        tokens,
        async close() {
            await repository.close();
        }
    };
}

async function login(fixture: Fixture, route = '/api/admin/auth/login') {
    return fixture.app.request(`http://ims.test${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: USERNAME, password: PASSWORD })
    });
}

test('canonical Backoffice auth lifecycle uses isolated routes and ims_admin cookies', async (t) => {
    const fixture = await createFixture(t);
    t.after(() => fixture.close());

    const loginResponse = await login(fixture);
    assert.equal(loginResponse.status, 200);
    assert.equal(loginResponse.headers.get('Deprecation'), null);
    const loginBody = await loginResponse.clone().json() as { token: string };
    const loginCookies = assertCanonicalCookies(loginResponse);

    assert.equal(jwtPart(loginBody.token, 0).alg, 'HS256');
    const claims = jwtPart(loginBody.token, 1);
    assert.equal(claims.iss, 'imsweb');
    assert.equal(claims.aud, 'ims-backoffice');
    assert.equal(claims.kind, 'backoffice');

    const session = await fixture.app.request('http://ims.test/api/admin/auth/session', {
        headers: { Cookie: cookieHeader(loginCookies) }
    });
    assert.equal(session.status, 200);
    assert.equal((await session.json() as { user: { username: string } }).user.username, USERNAME);

    const csrf = loginCookies.get(CSRF_COOKIE)!;
    const refreshed = await fixture.app.request('http://ims.test/api/admin/auth/refresh', {
        method: 'POST',
        headers: {
            Cookie: cookieHeader(loginCookies),
            'X-CSRFToken': csrf
        }
    });
    assert.equal(refreshed.status, 200);
    const refreshedCookies = assertCanonicalCookies(refreshed);
    assert.notEqual(refreshedCookies.get(ACCESS_COOKIE), loginCookies.get(ACCESS_COOKIE));
    assert.notEqual(refreshedCookies.get(REFRESH_COOKIE), loginCookies.get(REFRESH_COOKIE));
    assert.equal(refreshedCookies.get(CSRF_COOKIE), csrf);

    const logout = await fixture.app.request('http://ims.test/api/admin/auth/logout', {
        method: 'POST',
        headers: {
            Cookie: cookieHeader(refreshedCookies),
            'X-CSRFToken': csrf
        }
    });
    assert.equal(logout.status, 200);
    assertCanonicalCookies(logout, true);
});

test('Backoffice JWT verification fixes HS256 and rejects missing or wrong realm claims', async (t) => {
    const fixture = await createFixture(t);
    t.after(() => fixture.close());

    const valid = await fixture.tokens.sign({
        id: 1,
        username: USERNAME,
        producername: 'Boundary Producer',
        dept: 'op',
        adminRole: 'admin',
        csrfSecret: 'boundary-csrf',
        jti: 'boundary-jti'
    }, 600);
    assert.equal(jwtPart(valid, 0).alg, 'HS256');
    const claims = jwtPart(valid, 1);
    assert.equal(claims.iss, 'imsweb');
    assert.equal(claims.aud, 'ims-backoffice');
    assert.equal(claims.kind, 'backoffice');
    await assert.doesNotReject(fixture.tokens.verify(valid));

    const { iss: _issuer, ...withoutIssuer } = claims;
    const { aud: _audience, ...withoutAudience } = claims;
    const { kind: _kind, ...withoutKind } = claims;
    const invalidClaims: Record<string, Record<string, unknown>> = {
        'missing issuer': withoutIssuer,
        'wrong issuer': { ...claims, iss: `${String(claims.iss)}-other` },
        'missing audience': withoutAudience,
        'platform audience': { ...claims, aud: 'ims-platform' },
        'missing kind': withoutKind,
        'platform kind': { ...claims, kind: 'platform' }
    };
    for (const [label, payload] of Object.entries(invalidClaims)) {
        const token = await signJwt(payload, SECRET, 'HS256');
        await assert.rejects(fixture.tokens.verify(token), label);
    }
    const wrongAlgorithm = await signJwt(claims, SECRET, 'HS512');
    await assert.rejects(fixture.tokens.verify(wrongAlgorithm), 'HS512');
});

test('realm-less legacy JWTs are accepted only from the legacy Backoffice cookie', async (t) => {
    const fixture = await createFixture(t);
    t.after(() => fixture.close());

    const now = Math.floor(Date.now() / 1000);
    const legacyClaims = {
        id: 1,
        username: USERNAME,
        producername: 'Boundary Producer',
        dept: 'op',
        adminRole: 'admin',
        csrfSecret: 'legacy-boundary-csrf',
        iat: now,
        exp: now + 600
    };
    const legacyToken = await signJwt(legacyClaims, LEGACY_SECRET, 'HS256');

    for (const [label, headers] of [
        ['Authorization', { Authorization: `Bearer ${legacyToken}` }],
        ['canonical cookie', { Cookie: `${ACCESS_COOKIE}=${legacyToken}` }]
    ] as const) {
        const response = await fixture.app.request(
            'http://ims.test/api/admin/auth/session',
            { headers }
        );
        assert.equal(response.status, 401, label);
    }

    const legacyCookie = await fixture.app.request(
        'http://ims.test/api/admin/auth/session',
        { headers: { Cookie: `token=${legacyToken}` } }
    );
    assert.equal(legacyCookie.status, 200);

    const platformToken = await signJwt({
        ...legacyClaims,
        iss: 'imsweb',
        aud: 'ims-platform',
        kind: 'platform'
    }, LEGACY_SECRET, 'HS256');
    const platformCookie = await fixture.app.request(
        'http://ims.test/api/admin/auth/session',
        { headers: { Cookie: `token=${platformToken}` } }
    );
    assert.equal(platformCookie.status, 401);

    const strictOnlyFixture = await createFixture(t, null);
    t.after(() => strictOnlyFixture.close());
    const currentSecretLegacyToken = await signJwt(legacyClaims, SECRET, 'HS256');
    const disabledBridge = await strictOnlyFixture.app.request(
        'http://ims.test/api/admin/auth/session',
        { headers: { Cookie: `token=${currentSecretLegacyToken}` } }
    );
    assert.equal(disabledBridge.status, 401);
});

test('logout revokes coexisting canonical and legacy refresh sessions', async (t) => {
    for (const route of ['/api/admin/auth/logout', '/api/logout']) {
        const fixture = await createFixture(t);
        try {
            const canonical = cookieValues(await login(fixture));
            const legacy = cookieValues(await login(fixture, '/api/login'));
            const cookies = new Map([...canonical, ...legacy]);
            const sessions = await Promise.all([
                canonical.get(REFRESH_COOKIE)!,
                legacy.get('refresh_token')!
            ].map(async (token) => fixture.repository.findRefreshSessionByTokenHash(
                await hashBackofficeAuthSecret(token)
            )));
            assert.ok(sessions[0]);
            assert.ok(sessions[1]);
            assert.notEqual(sessions[0].id, sessions[1].id);

            const csrf = route === '/api/logout'
                ? legacy.get('csrf_token')!
                : canonical.get(CSRF_COOKIE)!;
            const response = await fixture.app.request(`http://ims.test${route}`, {
                method: 'POST',
                headers: {
                    Cookie: cookieHeader(cookies),
                    'X-CSRFToken': csrf
                }
            });
            assert.equal(response.status, 200, route);
            assert.deepEqual(
                setCookies(response).map((cookie) => cookie.split('=', 1)[0]).sort(),
                [
                    ACCESS_COOKIE,
                    CSRF_COOKIE,
                    REFRESH_COOKIE,
                    'csrf_token',
                    'refresh_token',
                    'token'
                ].sort()
            );
            for (const session of sessions) {
                assert.ok(session);
                const stored = await fixture.connection.prepare(
                    'SELECT revoked_at FROM backoffice_refresh_sessions WHERE id=?'
                ).bind(session.id).first<{ revoked_at: number | null }>();
                assert.equal(typeof stored?.revoked_at, 'number', route);
            }
            const canonicalReplay = await fixture.app.request(
                'http://ims.test/api/admin/auth/refresh',
                {
                    method: 'POST',
                    headers: {
                        Cookie: cookieHeader(canonical),
                        'X-CSRFToken': canonical.get(CSRF_COOKIE)!
                    }
                }
            );
            assert.equal(canonicalReplay.status, 401, route);
            const legacyReplay = await fixture.app.request('http://ims.test/api/refresh', {
                method: 'POST',
                headers: {
                    Cookie: cookieHeader(legacy),
                    'X-CSRFToken': legacy.get('csrf_token')!
                }
            });
            assert.equal(legacyReplay.status, 401, route);
        } finally {
            await fixture.close();
        }
    }
});

test('legacy Backoffice endpoints are deprecated and old cookies only bridge into Backoffice', async (t) => {
    const fixture = await createFixture(t);
    t.after(() => fixture.close());
    const logged = t.mock.method(console, 'warn', () => undefined);

    let legacyCookies = new Map<string, string>();
    for (const legacyLoginPath of ['/api/login', '/api/admin/login']) {
        const response = await login(fixture, legacyLoginPath);
        assert.equal(response.status, 200, legacyLoginPath);
        assertDeprecated(response, legacyLoginPath);
        const cookies = cookieValues(response);
        assert.deepEqual([...cookies.keys()].sort(), ['csrf_token', 'refresh_token', 'token']);
        if (legacyLoginPath === '/api/login') legacyCookies = cookies;
    }

    const canonicalSessionFromLegacyCookie = await fixture.app.request(
        'http://ims.test/api/admin/auth/session',
        { headers: { Cookie: cookieHeader(legacyCookies) } }
    );
    assert.equal(canonicalSessionFromLegacyCookie.status, 200);

    const legacySession = await fixture.app.request('http://ims.test/api/check', {
        headers: { Cookie: cookieHeader(legacyCookies) }
    });
    assert.equal(legacySession.status, 200);
    assertDeprecated(legacySession, '/api/check');

    const canonicalRefresh = await fixture.app.request(
        'http://ims.test/api/admin/auth/refresh',
        {
            method: 'POST',
            headers: {
                Cookie: cookieHeader(legacyCookies),
                'X-CSRFToken': legacyCookies.get('csrf_token')!
            }
        }
    );
    assert.equal(canonicalRefresh.status, 200);
    assertCanonicalCookies(canonicalRefresh, false, true);

    const secondLegacyLogin = await login(fixture, '/api/login');
    const secondLegacyCookies = cookieValues(secondLegacyLogin);
    const legacyRefresh = await fixture.app.request('http://ims.test/api/refresh', {
        method: 'POST',
        headers: {
            Cookie: cookieHeader(secondLegacyCookies),
            'X-CSRFToken': secondLegacyCookies.get('csrf_token')!
        }
    });
    assert.equal(legacyRefresh.status, 200);
    assertDeprecated(legacyRefresh, '/api/refresh');

    const logoutLogin = await login(fixture, '/api/login');
    const logoutCookies = cookieValues(logoutLogin);
    const legacyLogout = await fixture.app.request('http://ims.test/api/logout', {
        method: 'POST',
        headers: {
            Cookie: cookieHeader(logoutCookies),
            'X-CSRFToken': logoutCookies.get('csrf_token')!
        }
    });
    assert.equal(legacyLogout.status, 200);
    assertDeprecated(legacyLogout, '/api/logout');

    assert.deepEqual(
        logged.mock.calls.map((call) => JSON.parse(String(call.arguments[0]))),
        [
            { event: 'legacy_backoffice_auth_route_used', method: 'POST', path: '/api/login' },
            {
                event: 'legacy_backoffice_auth_route_used',
                method: 'POST',
                path: '/api/admin/login'
            },
            { event: 'legacy_backoffice_auth_route_used', method: 'GET', path: '/api/check' },
            { event: 'legacy_backoffice_auth_route_used', method: 'POST', path: '/api/login' },
            {
                event: 'legacy_backoffice_auth_route_used',
                method: 'POST',
                path: '/api/refresh'
            },
            { event: 'legacy_backoffice_auth_route_used', method: 'POST', path: '/api/login' },
            { event: 'legacy_backoffice_auth_route_used', method: 'POST', path: '/api/logout' }
        ]
    );
});
