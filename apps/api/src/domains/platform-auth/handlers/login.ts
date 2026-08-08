import type { Context } from 'hono';
import type { AppEnvironment } from '@/app';
import {
    establishPlatformSession,
    platformSessionPayload
} from '@/domains/platform-auth/platform-auth-session';
import {
    isBcryptPasswordSafe,
    isPlatformJsonContentType,
    isMigratedPbkdf2Parameters,
    parsePlatformLoginInput
} from '@/domains/platform-auth/platform-email-input';
import type { PlatformEmailIdentity } from '@/ports/repositories';
import { platformAccountRepository, services } from '@/middleware/hono-context';
import {
    enforceRateLimit,
    PLATFORM_AUTH_LOGIN_ACCOUNT_LIMIT,
    platformLoginAccountRateLimitKey
} from '@/middleware/rate-limit';

const BCRYPT_PARAMETERS_JSON = JSON.stringify({
    cost: 12,
    normalization: 'fudaba-trim'
});
const DUMMY_BCRYPT_HASH =
    '$2b$12$bnPpILj3dtzbslu5F3vG4u7RzdkxYLF23bfHQBZv2bUfM4byX6NQ6';

async function credentialMatches(
    c: Context<AppEnvironment>,
    password: string,
    identity: PlatformEmailIdentity
): Promise<boolean> {
    const passwords = services(c).passwords;
    if (!passwords) throw new Error('Platform password authentication services unavailable');
    try {
        if (identity.credential.algorithm === 'bcrypt') {
            return await passwords.verify(password, identity.credential.password_hash);
        }
        return Boolean(
            identity.credential.salt && passwords.verifyPbkdf2Sha256 &&
            isMigratedPbkdf2Parameters(identity.credential.parameters_json) &&
            await passwords.verifyPbkdf2Sha256(
                password,
                identity.credential.salt,
                identity.credential.password_hash
            )
        );
    } catch {
        return false;
    }
}

function invalidCredentials(c: Context<AppEnvironment>): Response {
    return c.json({ success: false, code: 'PLATFORM_CREDENTIALS_INVALID' }, 401);
}

export async function handlePlatformLogin(c: Context<AppEnvironment>): Promise<Response> {
    if (!isPlatformJsonContentType(c.req.header('content-type'))) {
        return c.json({ success: false, code: 'PLATFORM_AUTH_JSON_REQUIRED' }, 415);
    }
    const input = parsePlatformLoginInput(await c.req.json<unknown>().catch(() => null));
    if (!input) {
        return c.json({ success: false, code: 'PLATFORM_AUTH_INPUT_INVALID' }, 400);
    }
    const accountLimited = await enforceRateLimit(c, {
        ...PLATFORM_AUTH_LOGIN_ACCOUNT_LIMIT,
        rateLimitKey: platformLoginAccountRateLimitKey(input.normalizedEmail)
    });
    if (accountLimited) return accountLimited;
    const repository = platformAccountRepository(c);
    const passwords = services(c).passwords;
    if (!passwords?.hash) {
        throw new Error('Platform password authentication services unavailable');
    }
    let identity = await repository.findEmailIdentity(input.normalizedEmail);
    if (!identity) {
        await passwords.verify(input.password, DUMMY_BCRYPT_HASH).catch(() => false);
        return invalidCredentials(c);
    }
    if (!await credentialMatches(c, input.password, identity)) {
        if (identity.credential.algorithm === 'pbkdf2-sha256') {
            await passwords.verify(input.password, DUMMY_BCRYPT_HASH).catch(() => false);
        }
        return invalidCredentials(c);
    }
    if (identity.account.status === 'suspended') {
        return c.json({ success: false, code: 'PLATFORM_ACCOUNT_SUSPENDED' }, 403);
    }
    if (identity.account.status === 'deleted') {
        return c.json({ success: false, code: 'PLATFORM_ACCOUNT_UNAVAILABLE' }, 403);
    }
    if (
        identity.credential.algorithm === 'pbkdf2-sha256' &&
        isBcryptPasswordSafe(input.password)
    ) {
        const passwordHash = await passwords.hash(input.password);
        const upgraded = await repository.upgradeEmailCredentialToBcrypt({
            normalizedEmail: identity.credential.normalized_email,
            expectedAlgorithm: 'pbkdf2-sha256',
            expectedPasswordHash: identity.credential.password_hash,
            expectedUpdatedAt: identity.credential.updated_at,
            passwordHash,
            parametersJson: BCRYPT_PARAMETERS_JSON,
            updatedAt: Date.now()
        });
        const current = await repository.findEmailIdentity(input.normalizedEmail);
        if (
            !current || current.account.id !== identity.account.id ||
            (!upgraded && !await credentialMatches(c, input.password, current))
        ) {
            return invalidCredentials(c);
        }
        identity = current;
    }
    if (identity.account.status === 'suspended') {
        return c.json({ success: false, code: 'PLATFORM_ACCOUNT_SUSPENDED' }, 403);
    }
    if (identity.account.status === 'deleted') {
        return c.json({ success: false, code: 'PLATFORM_ACCOUNT_UNAVAILABLE' }, 403);
    }
    if (!await establishPlatformSession(c, identity)) {
        return c.json({
            success: false,
            code: 'PLATFORM_ACCOUNT_UNAVAILABLE'
        }, 403);
    }
    return c.json(await platformSessionPayload(c, identity));
}
