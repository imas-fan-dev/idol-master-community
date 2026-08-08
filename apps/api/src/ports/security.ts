export interface BackofficeJwtClaims {
    iss?: 'imsweb';
    aud?: 'ims-backoffice';
    kind?: 'backoffice';
    id: number;
    username: string;
    producername: string;
    dept: string;
    adminRole?: 'admin' | 'super_admin' | null;
    csrfSecret: string;
    iat?: number;
    exp?: number;
    [key: string]: unknown;
}

export type BackofficeAccessTokenInput = Omit<
    BackofficeJwtClaims,
    'iss' | 'aud' | 'kind' | 'iat' | 'exp'
>;

export interface BackofficeTokenService {
    sign(
        claims: BackofficeAccessTokenInput,
        expiresInSeconds: number
    ): Promise<string>;
    verify(token: string): Promise<BackofficeJwtClaims>;
    verifyLegacyCookie?(token: string): Promise<BackofficeJwtClaims>;
}

export interface PlatformJwtClaims {
    iss: 'imsweb';
    aud: 'ims-platform';
    kind: 'platform';
    id: string;
    tokenVersion: number;
    sessionId: string;
    csrfSecret: string;
    jti: string;
    iat: number;
    exp: number;
    [key: string]: unknown;
}

export type PlatformAccessTokenInput = Omit<
    PlatformJwtClaims,
    'iss' | 'aud' | 'kind' | 'jti' | 'iat' | 'exp'
>;

export interface PlatformTokenService {
    sign(
        claims: PlatformAccessTokenInput,
        expiresInSeconds: number
    ): Promise<string>;
    verify(token: string): Promise<PlatformJwtClaims>;
}

export interface PasswordVerifier {
    verify(value: string, digest: string): Promise<boolean>;
    hash?(value: string): Promise<string>;
    verifyPbkdf2Sha256?(
        value: string,
        salt: string,
        digest: string
    ): Promise<boolean>;
}

export interface SecurityServices {
    passwords: PasswordVerifier;
    backofficeTokens: BackofficeTokenService;
    platformTokens: PlatformTokenService;
}
