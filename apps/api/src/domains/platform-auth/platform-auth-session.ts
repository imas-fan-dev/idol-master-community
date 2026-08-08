import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnvironment } from '@/app';
import type {
    PlatformAccountWithProfile,
    PlatformRefreshSessionRecord,
    PlatformSecurityEventInput,
    PlatformSecurityEventType
} from '@/ports/repositories';
import { getClientAddress, platformAccountRepository, services } from '@/middleware/hono-context';
import { constantTimeEqual } from '@/utils/crypto/constant-time';
import { randomHex } from '@/utils/crypto/random';
import { sha256Hex } from '@/utils/crypto/sha256';

export const PLATFORM_ACCESS_TOKEN_COOKIE = 'ims_platform_access';
export const PLATFORM_REFRESH_TOKEN_COOKIE = 'ims_platform_refresh';
export const PLATFORM_CSRF_TOKEN_COOKIE = 'ims_platform_csrf';
export const PLATFORM_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const PLATFORM_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const PLATFORM_REFRESH_TOKEN_TTL_MS = PLATFORM_REFRESH_TOKEN_TTL_SECONDS * 1000;

function cookieOptions(c: Context<AppEnvironment>) {
    return {
        secure: services(c).config?.cookieSecure ?? false,
        sameSite: 'Lax' as const
    };
}

export function setPlatformAuthenticationCookies(
    c: Context<AppEnvironment>,
    values: { accessToken: string; refreshToken: string; csrfSecret: string }
): void {
    const common = cookieOptions(c);
    setCookie(c, PLATFORM_ACCESS_TOKEN_COOKIE, values.accessToken, {
        ...common,
        httpOnly: true,
        maxAge: PLATFORM_ACCESS_TOKEN_TTL_SECONDS,
        path: '/'
    });
    setCookie(c, PLATFORM_REFRESH_TOKEN_COOKIE, values.refreshToken, {
        ...common,
        httpOnly: true,
        maxAge: PLATFORM_REFRESH_TOKEN_TTL_SECONDS,
        path: '/api/platform/auth'
    });
    setCookie(c, PLATFORM_CSRF_TOKEN_COOKIE, values.csrfSecret, {
        ...common,
        httpOnly: false,
        maxAge: PLATFORM_REFRESH_TOKEN_TTL_SECONDS,
        path: '/'
    });
}

export function clearPlatformAuthenticationCookies(c: Context<AppEnvironment>): void {
    const common = cookieOptions(c);
    deleteCookie(c, PLATFORM_ACCESS_TOKEN_COOKIE, {
        ...common,
        httpOnly: true,
        path: '/'
    });
    deleteCookie(c, PLATFORM_REFRESH_TOKEN_COOKIE, {
        ...common,
        httpOnly: true,
        path: '/api/platform/auth'
    });
    deleteCookie(c, PLATFORM_CSRF_TOKEN_COOKIE, {
        ...common,
        httpOnly: false,
        path: '/'
    });
}

export function platformRefreshTokenCookie(
    c: Context<AppEnvironment>
): string | undefined {
    return getCookie(c, PLATFORM_REFRESH_TOKEN_COOKIE);
}

export async function hashPlatformAuthSecret(value: string): Promise<string> {
    return sha256Hex(new TextEncoder().encode(value));
}

export function createPlatformRefreshToken(tokenVersion: number): string {
    return `v1.${tokenVersion}.${randomHex(32)}`;
}

export function platformRefreshTokenVersion(refreshToken: string): number | null {
    const match = refreshToken.match(/^v1\.(\d+)\.[0-9a-f]{64}$/);
    // Imported/bootstrap sessions without a marker belong to the initial version.
    if (!match) return 0;
    const value = Number(match[1]);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export async function hasValidPlatformRefreshCsrf(
    c: Context<AppEnvironment>,
    session: PlatformRefreshSessionRecord
): Promise<boolean> {
    const header = c.req.header('x-csrftoken') || c.req.header('x-csrf-token') || '';
    const cookie = getCookie(c, PLATFORM_CSRF_TOKEN_COOKIE) || '';
    const cookieMatches = constantTimeEqual(header, cookie);
    const storedMatches = constantTimeEqual(
        await hashPlatformAuthSecret(header),
        session.csrf_hash
    );
    return cookieMatches && storedMatches;
}

function boundedHeader(value: string | undefined, maximum: number): string | null {
    const normalized = value?.trim();
    return normalized ? normalized.slice(0, maximum) : null;
}

export function platformSecurityEvent(
    c: Context<AppEnvironment>,
    accountId: string,
    eventType: PlatformSecurityEventType,
    reason: string
): PlatformSecurityEventInput {
    return {
        id: crypto.randomUUID(),
        accountId,
        eventType,
        requestId: boundedHeader(c.req.header('x-request-id'), 128),
        ipAddress: boundedHeader(getClientAddress(c), 64),
        userAgent: boundedHeader(c.req.header('user-agent'), 1024),
        metadataJson: JSON.stringify({ reason }),
        createdAt: Date.now()
    };
}

export async function platformSessionPayload(
    c: Context<AppEnvironment>,
    identity: PlatformAccountWithProfile
): Promise<{
    success: true;
    account: { id: string; status: PlatformAccountWithProfile['account']['status'] };
    profile: {
        displayName: string;
        avatarUrl: string | null;
        homeCity: string | null;
        bio: string;
    };
}> {
    const { account, profile } = identity;
    let avatarUrl = profile.avatar_external_url;
    if (!avatarUrl && profile.avatar_object_key) {
        avatarUrl = await services(c).storage?.createPublicReadUrl?.(
            profile.avatar_object_key
        ) ?? '/api/platform/me/avatar';
    }
    return {
        success: true,
        account: { id: account.id, status: account.status },
        profile: {
            displayName: profile.display_name,
            avatarUrl,
            homeCity: profile.home_city,
            bio: profile.bio
        }
    };
}

export async function establishPlatformSession(
    c: Context<AppEnvironment>,
    identity: PlatformAccountWithProfile
): Promise<{
    accessToken: string;
    refreshToken: string;
    csrfSecret: string;
    sessionId: string;
} | null> {
    if (!['active', 'restricted'].includes(identity.account.status)) {
        throw new Error('Platform account cannot establish a session');
    }
    const runtime = services(c);
    if (!runtime.platformTokens) {
        throw new Error('Platform authentication services unavailable');
    }
    const createdAt = Date.now();
    const sessionId = crypto.randomUUID();
    const refreshToken = createPlatformRefreshToken(identity.account.token_version);
    const csrfSecret = randomHex(32);
    const [accessToken, tokenHash, csrfHash] = await Promise.all([
        runtime.platformTokens.sign({
            id: identity.account.id,
            tokenVersion: identity.account.token_version,
            sessionId,
            csrfSecret
        }, PLATFORM_ACCESS_TOKEN_TTL_SECONDS),
        hashPlatformAuthSecret(refreshToken),
        hashPlatformAuthSecret(csrfSecret)
    ]);
    const created = await platformAccountRepository(c).createRefreshSession({
        id: sessionId,
        accountId: identity.account.id,
        accountTokenVersion: identity.account.token_version,
        tokenHash,
        csrfHash,
        expiresAt: createdAt + PLATFORM_REFRESH_TOKEN_TTL_MS,
        createdAt,
        event: platformSecurityEvent(
            c,
            identity.account.id,
            'auth.session.created',
            'platform_session_established'
        )
    });
    if (!created) return null;
    setPlatformAuthenticationCookies(c, { accessToken, refreshToken, csrfSecret });
    return { accessToken, refreshToken, csrfSecret, sessionId };
}
