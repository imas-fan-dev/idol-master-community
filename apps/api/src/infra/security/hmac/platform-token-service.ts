import { sign, verify } from 'hono/utils/jwt/jwt';
import type {
    PlatformAccessTokenInput,
    PlatformJwtClaims,
    PlatformTokenService
} from '@/ports/security';

export const PLATFORM_JWT_ISSUER = 'imsweb' as const;
export const PLATFORM_JWT_AUDIENCE = 'ims-platform' as const;
export const PLATFORM_JWT_KIND = 'platform' as const;

function requirePlatformClaims(payload: Record<string, unknown>): PlatformJwtClaims {
    if (
        payload.iss !== PLATFORM_JWT_ISSUER ||
        payload.aud !== PLATFORM_JWT_AUDIENCE ||
        payload.kind !== PLATFORM_JWT_KIND ||
        typeof payload.id !== 'string' || !payload.id ||
        typeof payload.tokenVersion !== 'number' ||
        !Number.isSafeInteger(payload.tokenVersion) || payload.tokenVersion < 0 ||
        typeof payload.sessionId !== 'string' || !payload.sessionId ||
        typeof payload.csrfSecret !== 'string' || !payload.csrfSecret ||
        typeof payload.jti !== 'string' || !payload.jti ||
        typeof payload.iat !== 'number' ||
        typeof payload.exp !== 'number' ||
        payload.exp <= Math.floor(Date.now() / 1000)
    ) {
        throw new Error('Invalid Platform JWT claims');
    }
    return payload as PlatformJwtClaims;
}

export class HmacPlatformTokenService implements PlatformTokenService {
    constructor(private readonly secret: string) {}

    async sign(
        claims: PlatformAccessTokenInput,
        expiresInSeconds: number
    ): Promise<string> {
        const iat = Math.floor(Date.now() / 1000);
        return sign({
            ...claims,
            iss: PLATFORM_JWT_ISSUER,
            aud: PLATFORM_JWT_AUDIENCE,
            kind: PLATFORM_JWT_KIND,
            jti: crypto.randomUUID(),
            iat,
            exp: iat + expiresInSeconds
        }, this.secret, 'HS256');
    }

    async verify(token: string): Promise<PlatformJwtClaims> {
        const payload = await verify(token, this.secret, 'HS256');
        return requirePlatformClaims(payload);
    }
}
