import type { Context } from 'hono';
import type { AppEnvironment } from '@/app';
import { randomHex } from '@/utils/crypto/random';
import {
    BACKOFFICE_ACCESS_TOKEN_TTL_SECONDS,
    BACKOFFICE_REFRESH_TOKEN_TTL_SECONDS,
    backofficeAccessTokenClaims,
    hashBackofficeAuthSecret,
    setBackofficeAuthenticationCookies,
    setLegacyBackofficeAuthenticationCookies
} from '@/domains/backoffice-auth/backoffice-auth-session';
import {
    auditRepository,
    backofficeAuthRepository,
    getClientAddress,
    services
} from '@/middleware/hono-context';

async function login(
    c: Context<AppEnvironment>,
    options: { requiredDepartment?: string; legacyCookies?: boolean } = {}
): Promise<Response> {
    let body: Record<string, unknown>;
    try {
        const candidate = await c.req.json<unknown>();
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
            throw new Error('Invalid login body');
        }
        body = candidate as Record<string, unknown>;
    } catch {
        return c.json({ success: false, message: '用户名或密码格式错误' }, 400);
    }
    const { username, password } = body;
    if (
        typeof username !== 'string' || typeof password !== 'string' ||
        username.length < 1 || username.length > 128 ||
        password.length < 1 || new TextEncoder().encode(password).byteLength > 1024
    ) {
        return c.json({ success: false, message: '用户名或密码格式错误' }, 400);
    }
    const runtime = services(c);
    if (!runtime.passwords || !runtime.backofficeTokens) {
        throw new Error('Backoffice authentication services unavailable');
    }
    const user = await backofficeAuthRepository(c).findUserByUsername(username);
    if (!user || !await runtime.passwords.verify(password, user.password)) {
        return c.json({ success: false, message: '用户名或密码错误' }, 401);
    }
    if (options.requiredDepartment && user.dept !== options.requiredDepartment) {
        return c.json({
            success: false,
            message: '当前账号没有管理工作台权限'
        }, 403);
    }
    const csrfSecret = randomHex(32);
    const refreshToken = randomHex(32);
    const now = Math.floor(Date.now() / 1000);
    const token = await runtime.backofficeTokens.sign(
        backofficeAccessTokenClaims(user, csrfSecret),
        BACKOFFICE_ACCESS_TOKEN_TTL_SECONDS
    );
    const [tokenHash, csrfHash] = await Promise.all([
        hashBackofficeAuthSecret(refreshToken),
        hashBackofficeAuthSecret(csrfSecret)
    ]);
    const repository = backofficeAuthRepository(c);
    await repository.deleteExpiredRefreshSessions(now);
    await repository.createRefreshSession({
        id: randomHex(16),
        accountId: user.id,
        tokenHash,
        csrfHash,
        expiresAt: now + BACKOFFICE_REFRESH_TOKEN_TTL_SECONDS,
        createdAt: now
    });
    try {
        await auditRepository(c).insertAuditLog({
            username: user.username,
            producername: user.producername || '',
            action: '登录',
            target: '-',
            ip: getClientAddress(c),
            time: new Date().toISOString()
        });
    } catch (error) {
        console.error(error);
    }
    const setAuthenticationCookies = options.legacyCookies
        ? setLegacyBackofficeAuthenticationCookies
        : setBackofficeAuthenticationCookies;
    setAuthenticationCookies(c, { accessToken: token, refreshToken, csrfSecret });
    return c.json({
        success: true,
        token,
        username: user.username,
        producername: user.producername,
        dept: user.dept,
        adminRole: user.admin_role
    });
}

export function handleBackofficeLogin(c: Context<AppEnvironment>): Promise<Response> {
    return login(c, { legacyCookies: true });
}

export function handleBackofficeAdminLogin(c: Context<AppEnvironment>): Promise<Response> {
    return login(c, { requiredDepartment: 'op', legacyCookies: true });
}

export function handleCanonicalBackofficeLogin(
    c: Context<AppEnvironment>
): Promise<Response> {
    return login(c);
}
