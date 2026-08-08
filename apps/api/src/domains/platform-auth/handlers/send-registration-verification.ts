import type { Context } from 'hono';
import type { AppEnvironment } from '@/app';
import {
    isPlatformJsonContentType,
    parsePlatformEmailVerificationRequest
} from '@/domains/platform-auth/platform-email-input';
import {
    PLATFORM_EMAIL_CODE_ATTEMPTS,
    PLATFORM_EMAIL_CODE_RESEND_MS,
    PLATFORM_EMAIL_CODE_TTL_MS,
    createPlatformEmailVerificationCode,
    createPlatformEmailVerificationDeliveryToken,
    hashPlatformEmailVerificationCode
} from '@/domains/platform-auth/platform-email-verification';
import { platformAccountRepository, services } from '@/middleware/hono-context';

function unavailable(c: Context<AppEnvironment>): Response {
    return c.json({
        success: false,
        code: 'PLATFORM_EMAIL_VERIFICATION_UNAVAILABLE'
    }, 503);
}

export async function handlePlatformRegistrationVerification(
    c: Context<AppEnvironment>
): Promise<Response> {
    if (!isPlatformJsonContentType(c.req.header('content-type'))) {
        return c.json({ success: false, code: 'PLATFORM_AUTH_JSON_REQUIRED' }, 415);
    }
    const input = parsePlatformEmailVerificationRequest(
        await c.req.json<unknown>().catch(() => null)
    );
    if (!input) {
        return c.json({ success: false, code: 'PLATFORM_AUTH_INPUT_INVALID' }, 400);
    }
    const sender = services(c).platformEmailSender;
    if (!sender?.available) return unavailable(c);

    const code = createPlatformEmailVerificationCode();
    const deliveryToken = createPlatformEmailVerificationDeliveryToken();
    const codeHash = hashPlatformEmailVerificationCode(input.normalizedEmail, code);
    const now = Date.now();
    const issued = await platformAccountRepository(c).issueEmailVerification({
        normalizedEmail: input.normalizedEmail,
        deliveryToken,
        codeHash,
        expiresAt: now + PLATFORM_EMAIL_CODE_TTL_MS,
        resendAfter: now + PLATFORM_EMAIL_CODE_RESEND_MS,
        attemptsRemaining: PLATFORM_EMAIL_CODE_ATTEMPTS,
        createdAt: now
    });
    if (issued.status === 'cooldown') {
        const retryAfterSeconds = Math.max(1, Math.ceil(issued.retryAfterMs / 1000));
        c.header('Retry-After', String(retryAfterSeconds));
        return c.json({
            success: false,
            code: 'PLATFORM_EMAIL_VERIFICATION_COOLDOWN',
            retryAfterSeconds
        }, 429);
    }

    try {
        await sender.sendRegistrationVerification({
            email: input.normalizedEmail,
            code,
            expiresInMinutes: PLATFORM_EMAIL_CODE_TTL_MS / 60_000
        });
    } catch {
        await platformAccountRepository(c).revokeEmailVerification(
            input.normalizedEmail,
            deliveryToken
        );
        return unavailable(c);
    }

    const delivered = await platformAccountRepository(c)
        .completeEmailVerificationDelivery(input.normalizedEmail, deliveryToken);
    if (!delivered) return unavailable(c);

    return c.json({
        success: true,
        retryAfterSeconds: PLATFORM_EMAIL_CODE_RESEND_MS / 1000
    }, 202);
}
