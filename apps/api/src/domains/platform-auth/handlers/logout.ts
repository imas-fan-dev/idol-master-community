import type { Context } from 'hono';
import type { AppEnvironment } from '@/app';
import {
    clearPlatformAuthenticationCookies,
    hashPlatformAuthSecret,
    hasValidPlatformRefreshCsrf,
    platformRefreshTokenCookie,
    platformSecurityEvent
} from '@/domains/platform-auth/platform-auth-session';
import { platformAccountRepository, services } from '@/middleware/hono-context';

async function revokeBearerSession(c: Context<AppEnvironment>, token: string): Promise<void> {
    const tokenService = services(c).platformTokens;
    if (!tokenService) return;
    let claims;
    try {
        claims = await tokenService.verify(token);
    } catch {
        return;
    }
    const repository = platformAccountRepository(c);
    const session = await repository.findRefreshSessionById(claims.sessionId);
    if (!session || session.account_id !== claims.id) return;
    await repository.revokeRefreshSession({
        id: session.id,
        accountId: claims.id,
        revokedAt: Date.now(),
        event: platformSecurityEvent(
            c,
            claims.id,
            'auth.logout',
            'bearer_logout'
        )
    });
}

export async function handlePlatformLogout(c: Context<AppEnvironment>): Promise<Response> {
    const authorization = (c.req.header('authorization') || '').trim();
    const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
    if (bearer) {
        await revokeBearerSession(c, bearer);
    } else {
        const refreshToken = platformRefreshTokenCookie(c);
        if (refreshToken) {
            const repository = platformAccountRepository(c);
            const session = await repository.findRefreshSessionByTokenHash(
                await hashPlatformAuthSecret(refreshToken)
            );
            if (session) {
                if (!await hasValidPlatformRefreshCsrf(c, session)) {
                    return c.json({ success: false, code: 'PLATFORM_CSRF_INVALID' }, 403);
                }
                await repository.revokeRefreshSession({
                    id: session.id,
                    accountId: session.account_id,
                    revokedAt: Date.now(),
                    event: platformSecurityEvent(
                        c,
                        session.account_id,
                        'auth.logout',
                        'refresh_cookie_logout'
                    )
                });
            }
        }
    }
    clearPlatformAuthenticationCookies(c);
    return c.json({ success: true });
}
