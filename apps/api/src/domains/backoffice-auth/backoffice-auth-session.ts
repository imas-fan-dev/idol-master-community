import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Context } from 'hono';
import type { AppEnvironment } from '@/app';
import type {
    BackofficeAccountRecord,
    BackofficeRefreshSessionRecord
} from '@/ports/repositories';
import type { BackofficeAccessTokenInput } from '@/ports/security';
import { constantTimeEqual } from '@/utils/crypto/constant-time';
import { randomHex } from '@/utils/crypto/random';
import { sha256Hex } from '@/utils/crypto/sha256';

export const BACKOFFICE_ACCESS_TOKEN_COOKIE = 'ims_admin_access';
export const BACKOFFICE_REFRESH_TOKEN_COOKIE = 'ims_admin_refresh';
export const BACKOFFICE_CSRF_TOKEN_COOKIE = 'ims_admin_csrf';
export const LEGACY_BACKOFFICE_ACCESS_TOKEN_COOKIE = 'token';
export const LEGACY_BACKOFFICE_REFRESH_TOKEN_COOKIE = 'refresh_token';
export const LEGACY_BACKOFFICE_CSRF_TOKEN_COOKIE = 'csrf_token';
export const BACKOFFICE_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const BACKOFFICE_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export type BackofficeCookieSource = 'canonical' | 'legacy';

export interface BackofficeCookieValue {
    source: BackofficeCookieSource;
    value: string;
}

function cookieOptions(c: Context<AppEnvironment>) {
    return {
        secure: c.get('services').config?.cookieSecure ?? false,
        sameSite: 'Lax' as const
    };
}

export function setBackofficeAuthenticationCookies(
    c: Context<AppEnvironment>,
    values: { accessToken: string; refreshToken: string; csrfSecret: string }
): void {
    const common = cookieOptions(c);
    setCookie(c, BACKOFFICE_ACCESS_TOKEN_COOKIE, values.accessToken, {
        ...common,
        httpOnly: true,
        maxAge: BACKOFFICE_ACCESS_TOKEN_TTL_SECONDS,
        path: '/'
    });
    setCookie(c, BACKOFFICE_REFRESH_TOKEN_COOKIE, values.refreshToken, {
        ...common,
        httpOnly: true,
        maxAge: BACKOFFICE_REFRESH_TOKEN_TTL_SECONDS,
        path: '/api'
    });
    setCookie(c, BACKOFFICE_CSRF_TOKEN_COOKIE, values.csrfSecret, {
        ...common,
        httpOnly: false,
        maxAge: BACKOFFICE_REFRESH_TOKEN_TTL_SECONDS,
        path: '/'
    });
}

export function setLegacyBackofficeAuthenticationCookies(
    c: Context<AppEnvironment>,
    values: { accessToken: string; refreshToken: string; csrfSecret: string }
): void {
    const common = cookieOptions(c);
    setCookie(c, LEGACY_BACKOFFICE_ACCESS_TOKEN_COOKIE, values.accessToken, {
        ...common,
        httpOnly: true,
        maxAge: BACKOFFICE_ACCESS_TOKEN_TTL_SECONDS,
        path: '/'
    });
    setCookie(c, LEGACY_BACKOFFICE_REFRESH_TOKEN_COOKIE, values.refreshToken, {
        ...common,
        httpOnly: true,
        maxAge: BACKOFFICE_REFRESH_TOKEN_TTL_SECONDS,
        path: '/api'
    });
    setCookie(c, LEGACY_BACKOFFICE_CSRF_TOKEN_COOKIE, values.csrfSecret, {
        ...common,
        httpOnly: false,
        maxAge: BACKOFFICE_REFRESH_TOKEN_TTL_SECONDS,
        path: '/'
    });
}

export function clearBackofficeAuthenticationCookies(c: Context<AppEnvironment>): void {
    const common = cookieOptions(c);
    deleteCookie(c, BACKOFFICE_ACCESS_TOKEN_COOKIE, { ...common, httpOnly: true, path: '/' });
    deleteCookie(c, BACKOFFICE_REFRESH_TOKEN_COOKIE, { ...common, httpOnly: true, path: '/api' });
    deleteCookie(c, BACKOFFICE_CSRF_TOKEN_COOKIE, { ...common, httpOnly: false, path: '/' });
}

export function clearLegacyBackofficeAuthenticationCookies(c: Context<AppEnvironment>): void {
    const common = cookieOptions(c);
    deleteCookie(c, LEGACY_BACKOFFICE_ACCESS_TOKEN_COOKIE, {
        ...common,
        httpOnly: true,
        path: '/'
    });
    deleteCookie(c, LEGACY_BACKOFFICE_REFRESH_TOKEN_COOKIE, {
        ...common,
        httpOnly: true,
        path: '/api'
    });
    deleteCookie(c, LEGACY_BACKOFFICE_CSRF_TOKEN_COOKIE, {
        ...common,
        httpOnly: false,
        path: '/'
    });
}

export function hasLegacyBackofficeAuthenticationCookie(
    c: Context<AppEnvironment>
): boolean {
    return Boolean(
        getCookie(c, LEGACY_BACKOFFICE_ACCESS_TOKEN_COOKIE) ||
        getCookie(c, LEGACY_BACKOFFICE_REFRESH_TOKEN_COOKIE) ||
        getCookie(c, LEGACY_BACKOFFICE_CSRF_TOKEN_COOKIE)
    );
}

function backofficeCookie(
    c: Context<AppEnvironment>,
    canonicalName: string,
    legacyName: string
): BackofficeCookieValue | undefined {
    const canonical = getCookie(c, canonicalName);
    if (canonical) return { source: 'canonical', value: canonical };
    const legacy = getCookie(c, legacyName);
    return legacy ? { source: 'legacy', value: legacy } : undefined;
}

export function backofficeAccessTokenCookie(
    c: Context<AppEnvironment>
): BackofficeCookieValue | undefined {
    return backofficeCookie(
        c,
        BACKOFFICE_ACCESS_TOKEN_COOKIE,
        LEGACY_BACKOFFICE_ACCESS_TOKEN_COOKIE
    );
}

export function backofficeRefreshTokenCookie(
    c: Context<AppEnvironment>
): BackofficeCookieValue | undefined {
    return backofficeCookie(
        c,
        BACKOFFICE_REFRESH_TOKEN_COOKIE,
        LEGACY_BACKOFFICE_REFRESH_TOKEN_COOKIE
    );
}

export function backofficeRefreshTokenCookies(
    c: Context<AppEnvironment>
): BackofficeCookieValue[] {
    const cookies: BackofficeCookieValue[] = [];
    const canonical = getCookie(c, BACKOFFICE_REFRESH_TOKEN_COOKIE);
    const legacy = getCookie(c, LEGACY_BACKOFFICE_REFRESH_TOKEN_COOKIE);
    if (canonical) cookies.push({ source: 'canonical', value: canonical });
    if (legacy) cookies.push({ source: 'legacy', value: legacy });
    return cookies;
}

export function legacyBackofficeRefreshTokenCookie(
    c: Context<AppEnvironment>
): BackofficeCookieValue | undefined {
    const value = getCookie(c, LEGACY_BACKOFFICE_REFRESH_TOKEN_COOKIE);
    return value ? { source: 'legacy', value } : undefined;
}

export async function hashBackofficeAuthSecret(value: string): Promise<string> {
    return sha256Hex(new TextEncoder().encode(value));
}

export async function hasValidBackofficeRefreshCsrf(
    c: Context<AppEnvironment>,
    session: BackofficeRefreshSessionRecord,
    source: BackofficeCookieSource
): Promise<boolean> {
    const header = c.req.header('x-csrftoken') || c.req.header('x-csrf-token') || '';
    const cookie = getCookie(
        c,
        source === 'canonical'
            ? BACKOFFICE_CSRF_TOKEN_COOKIE
            : LEGACY_BACKOFFICE_CSRF_TOKEN_COOKIE
    ) || '';
    if (!constantTimeEqual(header, cookie)) return false;
    return constantTimeEqual(await hashBackofficeAuthSecret(header), session.csrf_hash);
}

export function backofficeAccessTokenClaims(
    user: BackofficeAccountRecord,
    csrfSecret: string
): BackofficeAccessTokenInput {
    return {
        id: user.id,
        username: user.username,
        producername: user.producername || '',
        dept: user.dept,
        adminRole: user.admin_role,
        csrfSecret,
        jti: randomHex(16)
    };
}
