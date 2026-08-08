import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHonoApp } from '@/app';
import { SqlCoreRepository } from '@/infra/db/repositories/core-repository';
import { PostgresConnection } from '@/infra/db/postgresql/connection';
import { PostgresqlSchemaStrategy } from '@/infra/db/postgresql/schema-strategy';
import { executeSql, queryOne } from '@/infra/db/sql/query';
import { HmacBackofficeTokenService } from '@/infra/security/hmac/token-service';
import { hashBackofficeAuthSecret } from '@/domains/backoffice-auth/backoffice-auth-session';
import type { RuntimeServices } from '@/ports/runtime-services';
import { createPostgresTestDatabase } from './postgres-test-database';

const USERNAME = 'refresh-contract-op';
const NON_OP_USERNAME = 'refresh-contract-user';
const PASSWORD = 'refresh-contract-password';

interface AuthFixture {
    app: ReturnType<typeof createHonoApp>;
    connection: PostgresConnection;
    repository: SqlCoreRepository;
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
    return [...values].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('; ');
}

function jwtPayload(token: string): Record<string, unknown> {
    const payload = token.split('.')[1];
    if (!payload) throw new Error('JWT payload is missing');
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

async function createFixture(t: TestContext): Promise<AuthFixture> {
    const connection = await createPostgresTestDatabase(t, 'auth-refresh');
    const repository = new SqlCoreRepository(connection, new PostgresqlSchemaStrategy());
    await repository.initialize();
    await executeSql(connection,
        `INSERT INTO users (username, password, dept, producername, admin_role)
         VALUES (?, 'refresh-contract-digest', 'op', 'Refresh Contract Producer', 'admin')`,
        [USERNAME]
    );
    await executeSql(connection,
        `INSERT INTO users (username, password, dept, producername)
         VALUES (?, 'refresh-contract-digest', 'user', 'Refresh Contract User')`,
        [NON_OP_USERNAME]
    );
    const runtime: RuntimeServices = {
        backofficeAuth: repository,
        audit: repository,
        passwords: {
            async verify(value, digest) {
                return value === PASSWORD && digest === 'refresh-contract-digest';
            }
        },
        backofficeTokens: new HmacBackofficeTokenService(
            'refresh-contract-secret-at-least-thirty-two-bytes'
        ),
        config: { cookieSecure: false }
    };
    return {
        app: createHonoApp(() => runtime),
        connection,
        repository,
        async close() {
            await repository.close();
        }
    };
}

async function login(
    fixture: AuthFixture,
    options: { path?: string; username?: string } = {}
): Promise<{
    response: Response;
    cookies: Map<string, string>;
    body: { success: boolean; token?: string; message?: string };
}> {
    const response = await fixture.app.request(
        `http://ims.test${options.path || '/api/login'}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: options.username || USERNAME,
                password: PASSWORD
            })
        }
    );
    return {
        response,
        cookies: cookieValues(response),
        body: await response.json() as {
            success: boolean;
            token?: string;
            message?: string;
        }
    };
}

test('admin login rejects non-op users before creating a refresh session', async (t) => {
    const fixture = await createFixture(t);
    t.after(() => fixture.close());

    const denied = await login(fixture, {
        path: '/api/admin/login',
        username: NON_OP_USERNAME
    });
    assert.equal(denied.response.status, 403);
    assert.deepEqual(denied.body, {
        success: false,
        message: '当前账号没有管理工作台权限'
    });
    assert.deepEqual(setCookies(denied.response), []);
    assert.deepEqual(
        await queryOne<{ total: number }>(fixture.connection,
            'SELECT COUNT(*) AS total FROM auth_refresh_sessions'
        ),
        { total: 0 }
    );

    const regularLogin = await login(fixture, { username: NON_OP_USERNAME });
    assert.equal(regularLogin.response.status, 200);
});

test('admin login issues a refresh session for op users', async (t) => {
    const fixture = await createFixture(t);
    t.after(() => fixture.close());

    const session = await login(fixture, { path: '/api/admin/login' });
    assert.equal(session.response.status, 200);
    assert.deepEqual([...session.cookies.keys()].sort(), [
        'csrf_token',
        'refresh_token',
        'token'
    ]);
});

test('access JWT login creates a rotating refresh session with CSRF binding', async (t) => {
    const fixture = await createFixture(t);
    t.after(() => fixture.close());

    const session = await login(fixture);
    assert.equal(session.response.status, 200);
    assert.deepEqual([...session.cookies.keys()].sort(), [
        'csrf_token',
        'refresh_token',
        'token'
    ]);
    const token = session.body.token;
    assert.ok(token);
    const claims = jwtPayload(token);
    assert.equal(Number(claims.exp) - Number(claims.iat), 15 * 60);

    const refreshToken = session.cookies.get('refresh_token')!;
    const csrf = session.cookies.get('csrf_token')!;
    const stored = await fixture.repository.findRefreshSessionByTokenHash(
        await hashBackofficeAuthSecret(refreshToken)
    );
    assert.ok(stored);
    assert.equal(stored.token_hash, await hashBackofficeAuthSecret(refreshToken));
    assert.notEqual(stored.token_hash, refreshToken);

    const missingCsrf = await fixture.app.request('http://ims.test/api/refresh', {
        method: 'POST',
        headers: { Cookie: cookieHeader(session.cookies) }
    });
    assert.equal(missingCsrf.status, 403);

    const refreshed = await fixture.app.request('http://ims.test/api/refresh', {
        method: 'POST',
        headers: {
            Cookie: cookieHeader(session.cookies),
            'X-CSRFToken': csrf
        }
    });
    assert.equal(refreshed.status, 200);
    const nextCookies = cookieValues(refreshed);
    assert.notEqual(nextCookies.get('token'), session.cookies.get('token'));
    assert.notEqual(nextCookies.get('refresh_token'), refreshToken);
    assert.equal(nextCookies.get('csrf_token'), csrf);

    const check = await fixture.app.request('http://ims.test/api/check', {
        headers: { Cookie: cookieHeader(nextCookies) }
    });
    assert.equal(check.status, 200);

    const replayCookies = new Map(nextCookies);
    replayCookies.set('refresh_token', refreshToken);
    const replay = await fixture.app.request('http://ims.test/api/refresh', {
        method: 'POST',
        headers: {
            Cookie: cookieHeader(replayCookies),
            'X-CSRFToken': csrf
        }
    });
    assert.equal(replay.status, 401);

    const revokedSuccessor = await fixture.app.request('http://ims.test/api/refresh', {
        method: 'POST',
        headers: {
            Cookie: cookieHeader(nextCookies),
            'X-CSRFToken': csrf
        }
    });
    assert.equal(revokedSuccessor.status, 401);
});

test('logout revokes the refresh session and clears all authentication cookies', async (t) => {
    const fixture = await createFixture(t);
    t.after(() => fixture.close());

    const session = await login(fixture);
    const csrf = session.cookies.get('csrf_token')!;
    const logout = await fixture.app.request('http://ims.test/api/logout', {
        method: 'POST',
        headers: {
            Cookie: cookieHeader(session.cookies),
            'X-CSRFToken': csrf
        }
    });
    assert.equal(logout.status, 200);
    assert.deepEqual(
        setCookies(logout).map((cookie) => cookie.split('=', 1)[0]).sort(),
        [
            'csrf_token',
            'ims_admin_access',
            'ims_admin_csrf',
            'ims_admin_refresh',
            'refresh_token',
            'token'
        ]
    );
    for (const cookie of setCookies(logout)) assert.match(cookie, /Max-Age=0/i);

    const refresh = await fixture.app.request('http://ims.test/api/refresh', {
        method: 'POST',
        headers: {
            Cookie: cookieHeader(session.cookies),
            'X-CSRFToken': csrf
        }
    });
    assert.equal(refresh.status, 401);
});
