import type { PlatformEmailConfig } from '@/config/platform-email';
import type {
    PlatformEmailSender,
    PlatformEmailVerificationMessage
} from '@/ports/email';

class DisabledPlatformEmailSender implements PlatformEmailSender {
    readonly available = false;

    sendRegistrationVerification(): Promise<void> {
        return Promise.reject(new Error('Platform email delivery is unavailable'));
    }
}

class ConsolePlatformEmailSender implements PlatformEmailSender {
    readonly available = true;

    async sendRegistrationVerification(
        message: PlatformEmailVerificationMessage
    ): Promise<void> {
        const [local, domain = ''] = message.email.split('@');
        const masked = `${local.slice(0, 2)}***@${domain}`;
        console.info(
            `[dev-email] Platform registration code for ${masked}: ${message.code} ` +
            `(expires in ${message.expiresInMinutes} minutes)`
        );
    }
}

interface CloudflareEmailResponse {
    success?: boolean;
    result?: {
        delivered?: string[];
        permanent_bounces?: string[];
        queued?: string[];
    } | null;
}

interface CloudflarePlatformEmailSenderOptions {
    requestTimeoutMs?: number;
    retryDelayMs?: number;
}

interface CloudflareEmailAttemptResult {
    response: Response;
    payload: CloudflareEmailResponse | null;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_DELAY_MS = 250;

class CloudflarePlatformEmailSender implements PlatformEmailSender {
    readonly available = true;

    constructor(
        private readonly config: Extract<PlatformEmailConfig, { mode: 'cloudflare' }>,
        private readonly fetcher: typeof globalThis.fetch,
        private readonly requestTimeoutMs: number,
        private readonly retryDelayMs: number
    ) {}

    private async request(
        endpoint: string,
        init: RequestInit
    ): Promise<CloudflareEmailAttemptResult> {
        const controller = new AbortController();
        const timeoutError = new Error(
            'Cloudflare Email Service request timed out'
        );
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
                controller.abort(timeoutError);
                reject(timeoutError);
            }, this.requestTimeoutMs);
        });
        const requestPromise = (async () => {
            const response = await this.fetcher(endpoint, {
                ...init,
                signal: controller.signal
            });
            const retryable = response.status === 429 || response.status >= 500;
            if (retryable) return { response, payload: null };

            let payload: CloudflareEmailResponse | null;
            try {
                payload = await response.json() as CloudflareEmailResponse;
            } catch (error) {
                if (controller.signal.aborted) throw error;
                payload = null;
            }
            return { response, payload };
        })();

        try {
            return await Promise.race([requestPromise, timeoutPromise]);
        } finally {
            if (timeout !== undefined) clearTimeout(timeout);
        }
    }

    async sendRegistrationVerification(
        message: PlatformEmailVerificationMessage
    ): Promise<void> {
        const endpoint =
            `https://api.cloudflare.com/client/v4/accounts/` +
            `${this.config.accountId}/email/sending/send`;
        const text = [
            `Your IMSWeb registration verification code is ${message.code}.`,
            `It expires in ${message.expiresInMinutes} minutes.`,
            'If you did not request this code, you can ignore this message.'
        ].join('\n\n');
        const html = [
            '<p>Your IMSWeb registration verification code is:</p>',
            `<p><strong>${message.code}</strong></p>`,
            `<p>It expires in ${message.expiresInMinutes} minutes.</p>`,
            '<p>If you did not request this code, you can ignore this message.</p>'
        ].join('');

        for (let attempt = 0; attempt < 2; attempt += 1) {
            let result: CloudflareEmailAttemptResult;
            try {
                result = await this.request(endpoint, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${this.config.apiToken}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        to: message.email,
                        from: {
                            address: this.config.fromAddress,
                            name: this.config.fromName
                        },
                        subject: 'IMSWeb registration verification code',
                        text,
                        html
                    })
                });
            } catch {
                if (attempt === 0) {
                    await new Promise((resolve) => {
                        setTimeout(resolve, this.retryDelayMs);
                    });
                    continue;
                }
                throw new Error(
                    'Cloudflare Email Service could not be reached'
                );
            }
            const { response, payload } = result;
            const retryable = response.status === 429 || response.status >= 500;
            if (retryable && attempt === 0) {
                await new Promise((resolve) => {
                    setTimeout(resolve, this.retryDelayMs);
                });
                continue;
            }
            const accepted = payload?.result?.delivered?.includes(message.email) ||
                payload?.result?.queued?.includes(message.email);
            if (response.ok && payload?.success && accepted) return;
            throw new Error('Cloudflare Email Service rejected the verification email');
        }
    }
}

export function createPlatformEmailSender(
    config: PlatformEmailConfig,
    fetcher: typeof globalThis.fetch = globalThis.fetch,
    options: CloudflarePlatformEmailSenderOptions = {}
): PlatformEmailSender {
    if (config.mode === 'cloudflare') {
        return new CloudflarePlatformEmailSender(
            config,
            fetcher,
            options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
            options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
        );
    }
    if (config.mode === 'console') return new ConsolePlatformEmailSender();
    return new DisabledPlatformEmailSender();
}
