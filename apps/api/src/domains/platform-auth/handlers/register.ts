import type { Context } from 'hono';
import type { AppEnvironment } from '@/app';
import {
    establishPlatformSession,
    platformSessionPayload
} from '@/domains/platform-auth/platform-auth-session';
import {
    isPlatformJsonContentType,
    parsePlatformRegisterInput
} from '@/domains/platform-auth/platform-email-input';
import {
    hashPlatformEmailVerificationCode
} from '@/domains/platform-auth/platform-email-verification';
import { platformAccountRepository, services } from '@/middleware/hono-context';
import { randomHex } from '@/utils/crypto/random';

const BCRYPT_PARAMETERS_JSON = JSON.stringify({
    cost: 12,
    normalization: 'trim'
});

export async function handlePlatformRegister(
    c: Context<AppEnvironment>
): Promise<Response> {
    if (!isPlatformJsonContentType(c.req.header('content-type'))) {
        return c.json({ success: false, code: 'PLATFORM_AUTH_JSON_REQUIRED' }, 415);
    }
    const input = parsePlatformRegisterInput(
        await c.req.json<unknown>().catch(() => null)
    );
    if (!input) {
        return c.json({ success: false, code: 'PLATFORM_AUTH_INPUT_INVALID' }, 400);
    }
    const passwords = services(c).passwords;
    if (!passwords?.hash) {
        throw new Error('Platform password authentication services unavailable');
    }
    const passwordHash = await passwords.hash(input.password);
    const now = Date.now();
    const result = await platformAccountRepository(c).createVerifiedEmailAccount({
        id: crypto.randomUUID(),
        status: 'active',
        tokenVersion: 0,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        profile: {
            displayName: input.displayName,
            avatarObjectKey: null,
            avatarExternalUrl: null,
            homeCity: null,
            bio: '',
            updatedAt: now
        },
        credential: {
            normalizedEmail: input.normalizedEmail,
            algorithm: 'bcrypt',
            parametersJson: BCRYPT_PARAMETERS_JSON,
            passwordHash,
            createdAt: now,
            updatedAt: now
        },
        verification: {
            codeHash: hashPlatformEmailVerificationCode(
                input.normalizedEmail,
                input.code
            ),
            consumedToken: randomHex(32),
            verifiedAt: now
        }
    });
    if (result.status === 'verification-invalid') {
        return c.json({
            success: false,
            code: 'PLATFORM_EMAIL_VERIFICATION_INVALID'
        }, 400);
    }
    if (result.status === 'email-conflict') {
        return c.json({ success: false, code: 'PLATFORM_EMAIL_EXISTS' }, 409);
    }
    if (!await establishPlatformSession(c, result.identity)) {
        return c.json({
            success: false,
            code: 'PLATFORM_ACCOUNT_UNAVAILABLE'
        }, 403);
    }
    return c.json(await platformSessionPayload(c, result.identity), 201);
}
