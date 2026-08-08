import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import type { AppEnvironment } from '@/app';
import { PLATFORM_ACCESS_TOKEN_COOKIE } from '@/domains/platform-auth/platform-auth-session';
import { optionalPlatformAuth } from '@/middleware/hono-auth';
import type { PlatformJwtClaims } from '@/ports/security';
import type { RuntimeServices } from '@/ports/runtime-services';

const NOW = Date.now();
const CLAIMS: PlatformJwtClaims = {
    iss: 'imsweb',
    aud: 'ims-platform',
    kind: 'platform',
    id: 'platform-viewer',
    tokenVersion: 3,
    sessionId: 'platform-session',
    csrfSecret: 'csrf-secret',
    jti: 'access-token',
    iat: Math.floor(NOW / 1000),
    exp: Math.floor(NOW / 1000) + 300
};

function fixture(): {
    app: Hono<AppEnvironment>;
    verifiedTokens: string[];
} {
    const verifiedTokens: string[] = [];
    const runtime = {
        platformTokens: {
            async sign() { return 'unused'; },
            async verify(token: string) {
                verifiedTokens.push(token);
                if (token !== 'valid-platform') throw new Error('invalid token');
                return CLAIMS;
            }
        },
        platformAccounts: {
            async findRefreshSessionById(id: string) {
                return id === CLAIMS.sessionId ? {
                    id,
                    account_id: CLAIMS.id,
                    token_hash: 'hash',
                    previous_token_hash: null,
                    csrf_hash: 'csrf-hash',
                    expires_at: NOW + 60_000,
                    created_at: NOW,
                    updated_at: NOW,
                    revoked_at: null
                } : null;
            },
            async findAccountWithProfileById(id: string) {
                return id === CLAIMS.id ? {
                    account: {
                        id,
                        status: 'active',
                        token_version: CLAIMS.tokenVersion,
                        created_at: NOW,
                        updated_at: NOW,
                        deleted_at: null
                    },
                    profile: {
                        account_id: id,
                        display_name: 'Platform Viewer',
                        avatar_object_key: null,
                        avatar_external_url: null,
                        home_city: null,
                        bio: '',
                        updated_at: NOW
                    }
                } : null;
            }
        }
    } as unknown as RuntimeServices;
    const app = new Hono<AppEnvironment>();
    app.use('*', async (c, next) => {
        c.set('services', runtime);
        await next();
    });
    app.get('/optional', optionalPlatformAuth, (c) => c.json({
        viewerId: c.get('platformUser')?.id ?? null
    }));
    return { app, verifiedTokens };
}

test('optional Platform auth stays anonymous when Platform credentials are absent', async () => {
    const { app, verifiedTokens } = fixture();
    const response = await app.request('http://ims.test/optional', {
        headers: { cookie: 'ims_admin_access=backoffice-token' }
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { viewerId: null });
    assert.deepEqual(verifiedTokens, []);
});

test('optional Platform auth rejects invalid credentials instead of downgrading', async () => {
    const { app, verifiedTokens } = fixture();
    const response = await app.request('http://ims.test/optional', {
        headers: { cookie: `${PLATFORM_ACCESS_TOKEN_COOKIE}=invalid-platform` }
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
        success: false,
        code: 'PLATFORM_SESSION_INVALID'
    });
    assert.deepEqual(verifiedTokens, ['invalid-platform']);
});

test('optional Platform auth exposes only a fully validated Platform viewer', async () => {
    const { app, verifiedTokens } = fixture();
    const response = await app.request('http://ims.test/optional', {
        headers: { authorization: 'Bearer valid-platform' }
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { viewerId: CLAIMS.id });
    assert.deepEqual(verifiedTokens, ['valid-platform']);
});
