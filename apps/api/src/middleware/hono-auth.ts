import type { Context, MiddlewareHandler, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AppEnvironment } from '@/app';
import {
    BACKOFFICE_CSRF_TOKEN_COOKIE,
    LEGACY_BACKOFFICE_CSRF_TOKEN_COOKIE,
    backofficeAccessTokenCookie
} from '@/domains/backoffice-auth/backoffice-auth-session';
import {
    PLATFORM_ACCESS_TOKEN_COOKIE,
    PLATFORM_CSRF_TOKEN_COOKIE,
    clearPlatformAuthenticationCookies,
    hashPlatformAuthSecret,
    platformSecurityEvent
} from '@/domains/platform-auth/platform-auth-session';
import {
    backofficeAuthRepository,
    platformAccountRepository,
    services
} from '@/middleware/hono-context';
import { constantTimeEqual } from '@/utils/crypto/constant-time';

export async function authenticateBackofficeRequest(
    c: Context<AppEnvironment>
): Promise<Response | null> {
    const authorization = (c.req.header('authorization') || '').trim();
    const cookie = authorization ? undefined : backofficeAccessTokenCookie(c);
    const token = authorization
        ? authorization.replace(/^Bearer\s+/i, '')
        : cookie?.value;
    if (!token) return c.json({ success: false, message: '未登录' }, 401);
    const tokenService = services(c).backofficeTokens;
    if (!tokenService) return c.json({ success: false, message: 'token无效' }, 401);
    try {
        const claims = cookie?.source === 'legacy'
            ? await (tokenService.verifyLegacyCookie?.(token) ?? tokenService.verify(token))
            : await tokenService.verify(token);
        c.set('backofficeUser', claims);
        c.set(
            'backofficeAuthSource',
            authorization ? 'authorization' : cookie?.source === 'legacy'
                ? 'legacy-cookie'
                : 'cookie'
        );
    } catch {
        return c.json({ success: false, message: 'token无效' }, 401);
    }
    return null;
}

function invalidPlatformSession(c: Context<AppEnvironment>): Response {
    return c.json({ success: false, code: 'PLATFORM_SESSION_INVALID' }, 401);
}

export async function authenticatePlatformRequest(
    c: Context<AppEnvironment>
): Promise<Response | null> {
    const authorization = (c.req.header('authorization') || '').trim();
    const cookie = authorization ? undefined : getCookie(c, PLATFORM_ACCESS_TOKEN_COOKIE);
    const token = authorization
        ? authorization.replace(/^Bearer\s+/i, '')
        : cookie;
    const runtime = services(c);
    if (!token || !runtime.platformTokens || !runtime.platformAccounts) {
        return invalidPlatformSession(c);
    }
    let claims;
    try {
        claims = await runtime.platformTokens.verify(token);
    } catch {
        return invalidPlatformSession(c);
    }
    const repository = platformAccountRepository(c);
    const [session, identity] = await Promise.all([
        repository.findRefreshSessionById(claims.sessionId),
        repository.findAccountWithProfileById(claims.id)
    ]);
    const now = Date.now();
    if (
        !session || !identity || session.account_id !== claims.id ||
        session.revoked_at !== null || session.expires_at <= now
    ) {
        return invalidPlatformSession(c);
    }
    if (identity.account.token_version !== claims.tokenVersion) {
        await repository.revokeRefreshSession({
            id: session.id,
            accountId: identity.account.id,
            revokedAt: now,
            event: platformSecurityEvent(
                c,
                identity.account.id,
                'auth.account_blocked',
                'token_version_changed'
            )
        });
        clearPlatformAuthenticationCookies(c);
        return invalidPlatformSession(c);
    }
    if (
        identity.account.status === 'suspended' ||
        identity.account.status === 'deleted'
    ) {
        const code = identity.account.status === 'suspended'
            ? 'PLATFORM_ACCOUNT_SUSPENDED'
            : 'PLATFORM_ACCOUNT_UNAVAILABLE';
        await repository.revokeRefreshSession({
            id: session.id,
            accountId: identity.account.id,
            revokedAt: now,
            event: platformSecurityEvent(
                c,
                identity.account.id,
                'auth.account_blocked',
                identity.account.status
            )
        });
        clearPlatformAuthenticationCookies(c);
        return c.json({ success: false, code }, 403);
    }
    c.set('platformUser', claims);
    c.set('platformAccount', identity);
    c.set('platformAuthSource', authorization ? 'authorization' : 'cookie');
    return null;
}

export async function authenticateBackoffice(
    c: Context<AppEnvironment>,
    next: Next
): Promise<Response | void> {
    const failure = await authenticateBackofficeRequest(c);
    if (failure) return failure;
    await next();
}

export async function authenticatePlatform(
    c: Context<AppEnvironment>,
    next: Next
): Promise<Response | void> {
    const failure = await authenticatePlatformRequest(c);
    if (failure) return failure;
    await next();
}

export async function authenticateOptionalPlatform(
    c: Context<AppEnvironment>,
    next: Next
): Promise<Response | void> {
    const authorization = (c.req.header('authorization') || '').trim();
    const cookie = getCookie(c, PLATFORM_ACCESS_TOKEN_COOKIE);
    if (!authorization && !cookie) {
        await next();
        return;
    }
    const failure = await authenticatePlatformRequest(c);
    if (failure) return failure;
    await next();
}

export async function requireOp(c: Context<AppEnvironment>, next: Next): Promise<Response | void> {
    const claims = c.get('backofficeUser');
    if (claims?.dept !== 'op') {
        return c.json({ message: '无权限（仅op可访问）' }, 403);
    }
    await next();
}

export async function requireCurrentBackofficeOp(
    c: Context<AppEnvironment>,
    next: Next
): Promise<Response | void> {
    const claims = c.get('backofficeUser');
    if (!claims) return c.json({ success: false, message: '未登录' }, 401);
    const current = await backofficeAuthRepository(c).findUserById(claims.id);
    if (!current || current.dept !== 'op') {
        return c.json({ message: '无权限（仅op可访问）' }, 403);
    }
    c.set('backofficeUser', {
        ...claims,
        username: current.username,
        producername: current.producername || '',
        dept: current.dept,
        adminRole: current.admin_role
    });
    await next();
}

export async function requireSuperAdmin(
    c: Context<AppEnvironment>,
    next: Next
): Promise<Response | void> {
    const claims = c.get('backofficeUser');
    if (!claims) return c.json({ success: false, message: '未登录' }, 401);
    const current = await backofficeAuthRepository(c).findUserById(claims.id);
    if (
        !current || current.dept !== 'op' ||
        current.admin_role !== 'super_admin'
    ) {
        return c.json({ success: false, message: '仅最高管理员可执行此操作' }, 403);
    }
    c.set('backofficeUser', { ...claims, adminRole: current.admin_role });
    await next();
}

export async function protectBackofficeCsrf(
    c: Context<AppEnvironment>,
    next: Next
): Promise<Response | void> {
    if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) || c.get('backofficeAuthSource') === 'authorization') {
        await next();
        return;
    }
    const header = c.req.header('x-csrftoken') || c.req.header('x-csrf-token') || '';
    const cookie = getCookie(
        c,
        c.get('backofficeAuthSource') === 'legacy-cookie'
            ? LEGACY_BACKOFFICE_CSRF_TOKEN_COOKIE
            : BACKOFFICE_CSRF_TOKEN_COOKIE
    );
    if (!constantTimeEqual(header, cookie) || !constantTimeEqual(header, c.get('backofficeUser')?.csrfSecret)) {
        return c.json({ success: false, message: 'CSRF token invalid' }, 403);
    }
    await next();
}

export async function protectPlatformCsrf(
    c: Context<AppEnvironment>,
    next: Next
): Promise<Response | void> {
    if (
        ['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) ||
        c.get('platformAuthSource') === 'authorization'
    ) {
        await next();
        return;
    }
    const claims = c.get('platformUser');
    const header = c.req.header('x-csrftoken') || c.req.header('x-csrf-token') || '';
    const cookie = getCookie(c, PLATFORM_CSRF_TOKEN_COOKIE) || '';
    const session = claims
        ? await platformAccountRepository(c).findRefreshSessionById(claims.sessionId)
        : null;
    const storedHash = session?.csrf_hash;
    if (
        !claims || !session || session.account_id !== claims.id ||
        session.revoked_at !== null || session.expires_at <= Date.now() ||
        !constantTimeEqual(header, cookie) ||
        !constantTimeEqual(header, claims?.csrfSecret) ||
        !constantTimeEqual(await hashPlatformAuthSecret(header), storedHash)
    ) {
        return c.json({ success: false, code: 'PLATFORM_CSRF_INVALID' }, 403);
    }
    await next();
}

export async function requireActivePlatformMutation(
    c: Context<AppEnvironment>,
    next: Next
): Promise<Response | void> {
    const account = c.get('platformAccount')?.account;
    if (!account) return invalidPlatformSession(c);
    if (account.status !== 'active') {
        return c.json({ success: false, code: 'PLATFORM_ACCOUNT_RESTRICTED' }, 403);
    }
    await next();
}

export const backofficeAuth: MiddlewareHandler<AppEnvironment> = authenticateBackoffice;
export const platformAuth: MiddlewareHandler<AppEnvironment> = authenticatePlatform;
export const optionalPlatformAuth: MiddlewareHandler<AppEnvironment> =
    authenticateOptionalPlatform;
export const opOnly: MiddlewareHandler<AppEnvironment> = requireOp;
export const currentBackofficeOp: MiddlewareHandler<AppEnvironment> =
    requireCurrentBackofficeOp;
export const superAdminOnly: MiddlewareHandler<AppEnvironment> = requireSuperAdmin;
export const backofficeCsrf: MiddlewareHandler<AppEnvironment> = protectBackofficeCsrf;
export const platformCsrf: MiddlewareHandler<AppEnvironment> = protectPlatformCsrf;
export const activePlatformMutation: MiddlewareHandler<AppEnvironment> =
    requireActivePlatformMutation;
