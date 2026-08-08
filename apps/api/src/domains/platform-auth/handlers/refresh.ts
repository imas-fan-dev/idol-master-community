import type { Context } from 'hono';
import type { AppEnvironment } from '@/app';
import {
    PLATFORM_ACCESS_TOKEN_TTL_SECONDS,
    PLATFORM_REFRESH_TOKEN_TTL_MS,
    clearPlatformAuthenticationCookies,
    createPlatformRefreshToken,
    hashPlatformAuthSecret,
    hasValidPlatformRefreshCsrf,
    platformRefreshTokenCookie,
    platformRefreshTokenVersion,
    platformSecurityEvent,
    platformSessionPayload,
    setPlatformAuthenticationCookies
} from '@/domains/platform-auth/platform-auth-session';
import { platformAccountRepository, services } from '@/middleware/hono-context';
import { constantTimeEqual } from '@/utils/crypto/constant-time';
import { randomHex } from '@/utils/crypto/random';

function rejectRefresh(c: Context<AppEnvironment>): Response {
    clearPlatformAuthenticationCookies(c);
    return c.json({ success: false, code: 'PLATFORM_SESSION_INVALID' }, 401);
}

export async function handlePlatformRefresh(c: Context<AppEnvironment>): Promise<Response> {
    const refreshToken = platformRefreshTokenCookie(c);
    if (!refreshToken) return rejectRefresh(c);

    const repository = platformAccountRepository(c);
    const tokenHash = await hashPlatformAuthSecret(refreshToken);
    const session = await repository.findRefreshSessionByTokenHash(tokenHash);
    if (!session) return rejectRefresh(c);

    const now = Date.now();
    if (constantTimeEqual(session.previous_token_hash, tokenHash)) {
        await repository.revokeRefreshSessionForReplay({
            id: session.id,
            accountId: session.account_id,
            replayedTokenHash: tokenHash,
            revokedAt: now,
            event: platformSecurityEvent(
                c,
                session.account_id,
                'auth.refresh.replay',
                'previous_refresh_token_reused'
            )
        });
        return rejectRefresh(c);
    }
    if (
        session.revoked_at !== null || session.expires_at <= now ||
        !constantTimeEqual(session.token_hash, tokenHash)
    ) {
        return rejectRefresh(c);
    }
    if (!await hasValidPlatformRefreshCsrf(c, session)) {
        return c.json({ success: false, code: 'PLATFORM_CSRF_INVALID' }, 403);
    }

    const identity = await repository.findAccountWithProfileById(session.account_id);
    if (!identity) return rejectRefresh(c);
    if (platformRefreshTokenVersion(refreshToken) !== identity.account.token_version) {
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
        return rejectRefresh(c);
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

    const tokenService = services(c).platformTokens;
    if (!tokenService) throw new Error('Platform authentication services unavailable');
    const nextRefreshToken = createPlatformRefreshToken(identity.account.token_version);
    const nextCsrfSecret = randomHex(32);
    const [accessToken, nextTokenHash, nextCsrfHash] = await Promise.all([
        tokenService.sign({
            id: identity.account.id,
            tokenVersion: identity.account.token_version,
            sessionId: session.id,
            csrfSecret: nextCsrfSecret
        }, PLATFORM_ACCESS_TOKEN_TTL_SECONDS),
        hashPlatformAuthSecret(nextRefreshToken),
        hashPlatformAuthSecret(nextCsrfSecret)
    ]);
    const rotated = await repository.rotateRefreshSession({
        id: session.id,
        accountTokenVersion: identity.account.token_version,
        currentTokenHash: tokenHash,
        nextTokenHash,
        nextCsrfHash,
        nextExpiresAt: now + PLATFORM_REFRESH_TOKEN_TTL_MS,
        updatedAt: now,
        event: platformSecurityEvent(
            c,
            identity.account.id,
            'auth.refresh.succeeded',
            'refresh_token_rotated'
        )
    });
    if (!rotated) {
        const replayedAt = Date.now();
        await repository.revokeRefreshSessionForReplay({
            id: session.id,
            accountId: session.account_id,
            replayedTokenHash: tokenHash,
            revokedAt: replayedAt,
            event: platformSecurityEvent(
                c,
                session.account_id,
                'auth.refresh.replay',
                'concurrent_refresh_token_reuse'
            )
        });
        return rejectRefresh(c);
    }

    setPlatformAuthenticationCookies(c, {
        accessToken,
        refreshToken: nextRefreshToken,
        csrfSecret: nextCsrfSecret
    });
    return c.json(await platformSessionPayload(c, identity));
}
