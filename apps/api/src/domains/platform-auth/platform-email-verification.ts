import crypto from 'node:crypto';
import { PLATFORM_JWT_SECRET } from '@/config/env';

export const PLATFORM_EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
export const PLATFORM_EMAIL_CODE_RESEND_MS = 60 * 1000;
export const PLATFORM_EMAIL_CODE_ATTEMPTS = 5;

export function createPlatformEmailVerificationCode(): string {
    return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export function createPlatformEmailVerificationDeliveryToken(): string {
    return crypto.randomBytes(32).toString('hex');
}

export function hashPlatformEmailVerificationCode(
    normalizedEmail: string,
    code: string
): string {
    return crypto.createHmac('sha256', PLATFORM_JWT_SECRET)
        .update('platform-email-registration\0', 'utf8')
        .update(normalizedEmail, 'utf8')
        .update('\0', 'utf8')
        .update(code, 'utf8')
        .digest('hex');
}
