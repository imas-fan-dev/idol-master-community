import { sign, verify } from 'hono/utils/jwt/jwt';
import type {
    BackofficeAccessTokenInput,
    BackofficeJwtClaims,
    BackofficeTokenService
} from '@/ports/security';

export const BACKOFFICE_JWT_ISSUER = 'imsweb' as const;
export const BACKOFFICE_JWT_AUDIENCE = 'ims-backoffice' as const;
export const BACKOFFICE_JWT_KIND = 'backoffice' as const;

interface StrictBackofficeJwtClaims extends BackofficeJwtClaims {
    iss: typeof BACKOFFICE_JWT_ISSUER;
    aud: typeof BACKOFFICE_JWT_AUDIENCE;
    kind: typeof BACKOFFICE_JWT_KIND;
}

function hasBackofficeIdentityClaims(payload: Record<string, unknown>): boolean {
    return typeof payload.id === 'number' && Number.isSafeInteger(payload.id) &&
        typeof payload.username === 'string' &&
        typeof payload.dept === 'string' &&
        typeof payload.csrfSecret === 'string' &&
        (
            payload.adminRole === undefined || payload.adminRole === null ||
            payload.adminRole === 'admin' || payload.adminRole === 'super_admin'
        ) &&
        typeof payload.iat === 'number' &&
        typeof payload.exp === 'number' &&
        payload.exp > Math.floor(Date.now() / 1000);
}

function requireStrictBackofficeClaims(
    payload: Record<string, unknown>
): StrictBackofficeJwtClaims {
    if (
        !hasBackofficeIdentityClaims(payload) ||
        payload.iss !== BACKOFFICE_JWT_ISSUER ||
        payload.aud !== BACKOFFICE_JWT_AUDIENCE ||
        payload.kind !== BACKOFFICE_JWT_KIND
    ) {
        throw new Error('Invalid Backoffice JWT claims');
    }
    return {
        ...payload,
        producername: typeof payload.producername === 'string' ? payload.producername : '',
        iss: BACKOFFICE_JWT_ISSUER,
        aud: BACKOFFICE_JWT_AUDIENCE,
        kind: BACKOFFICE_JWT_KIND
    } as StrictBackofficeJwtClaims;
}

function upgradeLegacyBackofficeClaims(payload: Record<string, unknown>): BackofficeJwtClaims {
    if (
        !hasBackofficeIdentityClaims(payload) ||
        payload.iss !== undefined || payload.aud !== undefined || payload.kind !== undefined
    ) {
        throw new Error('Invalid legacy Backoffice JWT claims');
    }
    return {
        ...payload,
        producername: typeof payload.producername === 'string' ? payload.producername : '',
        iss: BACKOFFICE_JWT_ISSUER,
        aud: BACKOFFICE_JWT_AUDIENCE,
        kind: BACKOFFICE_JWT_KIND
    } as StrictBackofficeJwtClaims;
}

export class HmacBackofficeTokenService implements BackofficeTokenService {
    constructor(
        private readonly secret: string,
        private readonly legacySecret?: string
    ) {}

    async sign(
        claims: BackofficeAccessTokenInput,
        expiresInSeconds: number
    ): Promise<string> {
        const iat = Math.floor(Date.now() / 1000);
        return sign({
            ...claims,
            iss: BACKOFFICE_JWT_ISSUER,
            aud: BACKOFFICE_JWT_AUDIENCE,
            kind: BACKOFFICE_JWT_KIND,
            iat,
            exp: iat + expiresInSeconds
        }, this.secret, 'HS256');
    }

    async verify(token: string): Promise<BackofficeJwtClaims> {
        const payload = await verify(token, this.secret, 'HS256');
        return requireStrictBackofficeClaims(payload);
    }

    async verifyLegacyCookie(token: string): Promise<BackofficeJwtClaims> {
        try {
            return await this.verify(token);
        } catch (error) {
            if (!this.legacySecret) throw error;
            // Previous-release cookies may use the legacy secret and omit realm claims.
        }
        const payload = await verify(token, this.legacySecret, 'HS256');
        try {
            return requireStrictBackofficeClaims(payload);
        } catch {
            return upgradeLegacyBackofficeClaims(payload);
        }
    }
}
