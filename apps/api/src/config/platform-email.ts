import type { RuntimeEnvironment } from '@/config/env';

export type PlatformEmailConfig =
    | { mode: 'disabled' }
    | { mode: 'console' }
    | {
        mode: 'cloudflare';
        accountId: string;
        apiToken: string;
        fromAddress: string;
        fromName: string;
    };

function value(environment: NodeJS.ProcessEnv, name: string): string {
    return String(environment[name] || '').trim();
}

function validEmailAddress(email: string): boolean {
    return email.length <= 320 && /^\S+@\S+\.\S+$/.test(email);
}

export function parsePlatformEmailConfig(
    environment: NodeJS.ProcessEnv = process.env,
    runtime = String(environment.NODE_ENV || 'development') as RuntimeEnvironment
): PlatformEmailConfig {
    const configuredMode = value(environment, 'IMS_PLATFORM_EMAIL_DELIVERY').toLowerCase();
    const cloudflareValues = [
        value(environment, 'IMS_CLOUDFLARE_EMAIL_ACCOUNT_ID'),
        value(environment, 'IMS_CLOUDFLARE_EMAIL_API_TOKEN'),
        value(environment, 'IMS_PLATFORM_EMAIL_FROM')
    ];
    const mode = configuredMode || (
        cloudflareValues.some(Boolean)
            ? 'cloudflare'
            : runtime === 'development' ? 'console' : 'disabled'
    );

    if (!['disabled', 'console', 'cloudflare'].includes(mode)) {
        throw new Error(
            'IMS_PLATFORM_EMAIL_DELIVERY must be disabled, console, or cloudflare'
        );
    }
    if (mode === 'disabled') return { mode: 'disabled' };
    if (mode === 'console') {
        if (runtime === 'production') {
            throw new Error('Console email delivery is forbidden in production');
        }
        return { mode: 'console' };
    }

    const [accountId, apiToken, fromAddress] = cloudflareValues;
    if (!/^[a-f0-9]{32}$/i.test(accountId)) {
        throw new Error(
            'IMS_CLOUDFLARE_EMAIL_ACCOUNT_ID must be a 32-character account id'
        );
    }
    if (!apiToken) {
        throw new Error('IMS_CLOUDFLARE_EMAIL_API_TOKEN is required');
    }
    if (!validEmailAddress(fromAddress)) {
        throw new Error('IMS_PLATFORM_EMAIL_FROM must be a valid email address');
    }
    const fromName = value(environment, 'IMS_PLATFORM_EMAIL_FROM_NAME') || 'IMSWeb';
    if (fromName.length > 100 || /[\u0000-\u001f\u007f]/.test(fromName)) {
        throw new Error('IMS_PLATFORM_EMAIL_FROM_NAME is invalid');
    }
    return {
        mode: 'cloudflare',
        accountId,
        apiToken,
        fromAddress,
        fromName
    };
}
