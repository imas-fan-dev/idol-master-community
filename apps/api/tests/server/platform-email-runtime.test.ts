import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlatformEmailConfig } from '@/config/platform-email';
import { createPlatformEmailSender } from '@/infra/email/cloudflare/platform-email-sender';
import type { PlatformEmailVerificationMessage } from '@/ports/email';

const CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
const CLOUDFLARE_API_TOKEN = 'cloudflare-test-token';
const FROM_ADDRESS = 'accounts@example.test';
const VERIFICATION_MESSAGE: PlatformEmailVerificationMessage = {
    email: 'producer@example.test',
    code: '123456',
    expiresInMinutes: 10
};

function cloudflareEnvironment(
    overrides: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv {
    return {
        IMS_PLATFORM_EMAIL_DELIVERY: 'cloudflare',
        IMS_CLOUDFLARE_EMAIL_ACCOUNT_ID: CLOUDFLARE_ACCOUNT_ID,
        IMS_CLOUDFLARE_EMAIL_API_TOKEN: CLOUDFLARE_API_TOKEN,
        IMS_PLATFORM_EMAIL_FROM: FROM_ADDRESS,
        IMS_PLATFORM_EMAIL_FROM_NAME: 'IMSWeb Accounts',
        ...overrides
    };
}

function jsonResponse(
    status: number,
    body: unknown
): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

function acceptedResponse(
    state: 'delivered' | 'queued',
    email = VERIFICATION_MESSAGE.email
): Response {
    return jsonResponse(200, {
        success: true,
        result: { [state]: [email] }
    });
}

test('platform email config defaults to console only in development', () => {
    assert.deepEqual(parsePlatformEmailConfig({}, 'development'), {
        mode: 'console'
    });
    assert.deepEqual(parsePlatformEmailConfig({}, 'production'), {
        mode: 'disabled'
    });
});

test('platform email config forbids console delivery in production', () => {
    assert.throws(
        () => parsePlatformEmailConfig({
            IMS_PLATFORM_EMAIL_DELIVERY: ' console '
        }, 'production'),
        /Console email delivery is forbidden in production/
    );
});

test('platform email config parses complete Cloudflare credentials', () => {
    assert.deepEqual(
        parsePlatformEmailConfig(cloudflareEnvironment(), 'production'),
        {
            mode: 'cloudflare',
            accountId: CLOUDFLARE_ACCOUNT_ID,
            apiToken: CLOUDFLARE_API_TOKEN,
            fromAddress: FROM_ADDRESS,
            fromName: 'IMSWeb Accounts'
        }
    );
});

test('platform email config rejects missing Cloudflare credentials', () => {
    assert.throws(
        () => parsePlatformEmailConfig(cloudflareEnvironment({
            IMS_CLOUDFLARE_EMAIL_ACCOUNT_ID: ''
        }), 'production'),
        /IMS_CLOUDFLARE_EMAIL_ACCOUNT_ID must be a 32-character account id/
    );
    assert.throws(
        () => parsePlatformEmailConfig(cloudflareEnvironment({
            IMS_CLOUDFLARE_EMAIL_API_TOKEN: ''
        }), 'production'),
        /IMS_CLOUDFLARE_EMAIL_API_TOKEN is required/
    );
    assert.throws(
        () => parsePlatformEmailConfig(cloudflareEnvironment({
            IMS_PLATFORM_EMAIL_FROM: ''
        }), 'production'),
        /IMS_PLATFORM_EMAIL_FROM must be a valid email address/
    );
});

test('platform email config rejects malformed account, sender, and name values', () => {
    for (const accountId of [
        'too-short',
        'g123456789abcdef0123456789abcdef',
        '0123456789abcdef0123456789abcdef0'
    ]) {
        assert.throws(
            () => parsePlatformEmailConfig(cloudflareEnvironment({
                IMS_CLOUDFLARE_EMAIL_ACCOUNT_ID: accountId
            }), 'production'),
            /IMS_CLOUDFLARE_EMAIL_ACCOUNT_ID must be a 32-character account id/
        );
    }

    for (const fromAddress of [
        'not-an-email',
        'sender @example.test',
        `sender@${'x'.repeat(320)}.test`
    ]) {
        assert.throws(
            () => parsePlatformEmailConfig(cloudflareEnvironment({
                IMS_PLATFORM_EMAIL_FROM: fromAddress
            }), 'production'),
            /IMS_PLATFORM_EMAIL_FROM must be a valid email address/
        );
    }

    for (const fromName of ['IMSWeb\nBCC', 'x'.repeat(101)]) {
        assert.throws(
            () => parsePlatformEmailConfig(cloudflareEnvironment({
                IMS_PLATFORM_EMAIL_FROM_NAME: fromName
            }), 'production'),
            /IMS_PLATFORM_EMAIL_FROM_NAME is invalid/
        );
    }
});

test('disabled platform email sender is unavailable and rejects sends', async () => {
    const sender = createPlatformEmailSender({ mode: 'disabled' });

    assert.equal(sender.available, false);
    await assert.rejects(
        sender.sendRegistrationVerification(VERIFICATION_MESSAGE),
        /Platform email delivery is unavailable/
    );
});

test('console platform email sender masks the recipient address', async (t) => {
    const logs: unknown[][] = [];
    t.mock.method(console, 'info', (...values: unknown[]) => {
        logs.push(values);
    });
    const sender = createPlatformEmailSender({ mode: 'console' });

    assert.equal(sender.available, true);
    await sender.sendRegistrationVerification(VERIFICATION_MESSAGE);

    assert.equal(logs.length, 1);
    const output = logs[0].join(' ');
    assert.match(output, /pr\*\*\*@example\.test/);
    assert.match(output, /123456/);
    assert.doesNotMatch(output, /producer@example\.test/);
});

test('Cloudflare platform email sender submits the expected REST request', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init });
        return acceptedResponse('delivered');
    }) as typeof globalThis.fetch;
    const config = parsePlatformEmailConfig(
        cloudflareEnvironment(),
        'production'
    );
    const sender = createPlatformEmailSender(config, fetcher);

    assert.equal(sender.available, true);
    await sender.sendRegistrationVerification(VERIFICATION_MESSAGE);

    assert.equal(calls.length, 1);
    assert.equal(
        calls[0].input,
        `https://api.cloudflare.com/client/v4/accounts/` +
        `${CLOUDFLARE_ACCOUNT_ID}/email/sending/send`
    );
    assert.equal(calls[0].init?.method, 'POST');
    assert.ok(calls[0].init?.signal instanceof AbortSignal);
    assert.deepEqual(calls[0].init?.headers, {
        Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json'
    });
    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
    assert.equal(body.to, VERIFICATION_MESSAGE.email);
    assert.deepEqual(body.from, {
        address: FROM_ADDRESS,
        name: 'IMSWeb Accounts'
    });
    assert.equal(body.subject, 'IMSWeb registration verification code');
    assert.match(String(body.text), /123456/);
    assert.match(String(body.text), /10 minutes/);
    assert.match(String(body.html), /<strong>123456<\/strong>/);
});

test('Cloudflare platform email sender clears its timeout after success', async () => {
    const signals: AbortSignal[] = [];
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        assert.ok(init?.signal instanceof AbortSignal);
        signals.push(init.signal);
        return acceptedResponse('delivered');
    }) as typeof globalThis.fetch;
    const sender = createPlatformEmailSender(
        parsePlatformEmailConfig(cloudflareEnvironment(), 'production'),
        fetcher,
        { requestTimeoutMs: 10, retryDelayMs: 0 }
    );

    await sender.sendRegistrationVerification(VERIFICATION_MESSAGE);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(signals.length, 1);
    assert.equal(signals[0].aborted, false);
});

test('Cloudflare platform email sender accepts delivered and queued results', async () => {
    for (const state of ['delivered', 'queued'] as const) {
        let calls = 0;
        const fetcher = (async () => {
            calls += 1;
            return acceptedResponse(state);
        }) as typeof globalThis.fetch;
        const sender = createPlatformEmailSender(
            parsePlatformEmailConfig(cloudflareEnvironment(), 'production'),
            fetcher
        );

        await sender.sendRegistrationVerification(VERIFICATION_MESSAGE);
        assert.equal(calls, 1);
    }
});

test('Cloudflare platform email sender retries one 429 response', async () => {
    const responses = [
        jsonResponse(429, { success: false }),
        acceptedResponse('queued')
    ];
    let calls = 0;
    const fetcher = (async () => responses[calls++]) as typeof globalThis.fetch;
    const sender = createPlatformEmailSender(
        parsePlatformEmailConfig(cloudflareEnvironment(), 'production'),
        fetcher
    );

    await sender.sendRegistrationVerification(VERIFICATION_MESSAGE);
    assert.equal(calls, 2);
});

test('Cloudflare platform email sender retries one server error only', async () => {
    let calls = 0;
    const fetcher = (async () => {
        calls += 1;
        return jsonResponse(503, { success: false });
    }) as typeof globalThis.fetch;
    const sender = createPlatformEmailSender(
        parsePlatformEmailConfig(cloudflareEnvironment(), 'production'),
        fetcher
    );

    await assert.rejects(
        sender.sendRegistrationVerification(VERIFICATION_MESSAGE),
        /Cloudflare Email Service rejected the verification email/
    );
    assert.equal(calls, 2);
});

test('Cloudflare platform email sender retries one network failure', async () => {
    let calls = 0;
    const fetcher = (async () => {
        calls += 1;
        if (calls === 1) throw new TypeError('network unavailable');
        return acceptedResponse('delivered');
    }) as typeof globalThis.fetch;
    const sender = createPlatformEmailSender(
        parsePlatformEmailConfig(cloudflareEnvironment(), 'production'),
        fetcher
    );

    await sender.sendRegistrationVerification(VERIFICATION_MESSAGE);
    assert.equal(calls, 2);
});

test('Cloudflare platform email sender bounds a fetch that never resolves', {
    timeout: 500
}, async () => {
    const signals: AbortSignal[] = [];
    let calls = 0;
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls += 1;
        assert.ok(init?.signal instanceof AbortSignal);
        signals.push(init.signal);
        return await new Promise<Response>(() => {});
    }) as typeof globalThis.fetch;
    const sender = createPlatformEmailSender(
        parsePlatformEmailConfig(cloudflareEnvironment(), 'production'),
        fetcher,
        { requestTimeoutMs: 10, retryDelayMs: 0 }
    );

    await assert.rejects(
        sender.sendRegistrationVerification(VERIFICATION_MESSAGE),
        /Cloudflare Email Service could not be reached/
    );

    assert.equal(calls, 2);
    assert.equal(signals.length, 2);
    assert.notEqual(signals[0], signals[1]);
    assert.ok(signals.every((signal) => signal.aborted));
});

test('Cloudflare platform email sender retries abort errors without leaking secrets', {
    timeout: 500
}, async () => {
    const signals: AbortSignal[] = [];
    let calls = 0;
    const fetcher = ((_input: RequestInfo | URL, init?: RequestInit) => {
        calls += 1;
        const signal = init?.signal;
        assert.ok(signal instanceof AbortSignal);
        signals.push(signal);
        return new Promise<Response>((_resolve, reject) => {
            signal.addEventListener('abort', () => {
                reject(new Error(
                    `upstream failure using ${CLOUDFLARE_API_TOKEN}`
                ));
            }, { once: true });
        });
    }) as typeof globalThis.fetch;
    const sender = createPlatformEmailSender(
        parsePlatformEmailConfig(cloudflareEnvironment(), 'production'),
        fetcher,
        { requestTimeoutMs: 10, retryDelayMs: 0 }
    );

    await assert.rejects(
        sender.sendRegistrationVerification(VERIFICATION_MESSAGE),
        (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal(
                error.message,
                'Cloudflare Email Service could not be reached'
            );
            assert.doesNotMatch(error.message, new RegExp(CLOUDFLARE_API_TOKEN));
            return true;
        }
    );

    assert.equal(calls, 2);
    assert.equal(signals.length, 2);
    assert.ok(signals.every((signal) => signal.aborted));
    assert.ok(signals.every((signal) => (
        signal.reason instanceof Error &&
        signal.reason.message === 'Cloudflare Email Service request timed out'
    )));
});

test('Cloudflare platform email sender rejects permanent bounces', async () => {
    let calls = 0;
    const fetcher = (async () => {
        calls += 1;
        return jsonResponse(200, {
            success: true,
            result: {
                permanent_bounces: [VERIFICATION_MESSAGE.email]
            }
        });
    }) as typeof globalThis.fetch;
    const sender = createPlatformEmailSender(
        parsePlatformEmailConfig(cloudflareEnvironment(), 'production'),
        fetcher
    );

    await assert.rejects(
        sender.sendRegistrationVerification(VERIFICATION_MESSAGE),
        /Cloudflare Email Service rejected the verification email/
    );
    assert.equal(calls, 1);
});
