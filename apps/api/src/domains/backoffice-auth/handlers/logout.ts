import type { Context } from 'hono';
import type { AppEnvironment } from '@/app';
import {
    clearBackofficeAuthenticationCookies,
    clearLegacyBackofficeAuthenticationCookies,
    hashBackofficeAuthSecret,
    hasLegacyBackofficeAuthenticationCookie,
    hasValidBackofficeRefreshCsrf,
    backofficeRefreshTokenCookies
} from '@/domains/backoffice-auth/backoffice-auth-session';
import { backofficeAuthRepository } from '@/middleware/hono-context';

async function logoutBackoffice(
    c: Context<AppEnvironment>,
    legacyRoute: boolean
): Promise<Response> {
    const refreshCookies = backofficeRefreshTokenCookies(c);
    if (refreshCookies.length > 0) {
        const repository = backofficeAuthRepository(c);
        const resolved = await Promise.all(refreshCookies.map(async (cookie) => ({
            cookie,
            session: await repository.findRefreshSessionByTokenHash(
                await hashBackofficeAuthSecret(cookie.value)
            )
        })));
        const preferredSource = legacyRoute ? 'legacy' : 'canonical';
        const authenticated = resolved.find((entry) => (
            entry.cookie.source === preferredSource && entry.session
        )) ?? resolved.find((entry) => entry.session);
        if (authenticated?.session) {
            if (!await hasValidBackofficeRefreshCsrf(
                c,
                authenticated.session,
                authenticated.cookie.source
            )) {
                return c.json({ success: false, message: 'CSRF token invalid' }, 403);
            }
            const revokedAt = Math.floor(Date.now() / 1000);
            const sessionIds = new Set(
                resolved.flatMap((entry) => (
                    entry.session?.account_id === authenticated.session!.account_id
                        ? [entry.session.id]
                        : []
                ))
            );
            await Promise.all([...sessionIds].map((id) => (
                repository.revokeRefreshSession(id, revokedAt)
            )));
        }
    }
    const hadLegacyCookies = hasLegacyBackofficeAuthenticationCookie(c);
    clearBackofficeAuthenticationCookies(c);
    if (hadLegacyCookies || legacyRoute) {
        clearLegacyBackofficeAuthenticationCookies(c);
    }
    return c.json({ success: true });
}

export function handleBackofficeLogout(c: Context<AppEnvironment>): Promise<Response> {
    return logoutBackoffice(c, false);
}

export function handleLegacyBackofficeLogout(
    c: Context<AppEnvironment>
): Promise<Response> {
    return logoutBackoffice(c, true);
}
