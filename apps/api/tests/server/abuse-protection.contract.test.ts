import assert from 'node:assert/strict';
import test from 'node:test';
import { createHonoApp } from '@/app';
import { MemoryRateLimiter } from '@/infra/cache/memory/rate-limiter';
import { JSON_BODY_MAX_BYTES } from '@/middleware/json-body-limit';
import type { BackofficeAuthRepository, ReactionRepository } from '@/ports/repositories';
import type { ObjectStorage } from '@/ports/object-storage';
import type { RuntimeServices } from '@/ports/runtime-services';
import { assertAbuseProtectionContract } from '../contracts/runtime-contracts.js';

const CARD_ID = 700;
const CLIENT_ADDRESS = '203.0.113.70';

test('[SECURITY] shared JSON and abuse limits use the Node memory limiter', async () => {
    const limiter = new MemoryRateLimiter();
    let rejectNextGlobal = false;
    let compensationRuns = 0;
    const calls = { userLookups: 0, reactionLookups: 0, reactionMutations: 0 };
    const core = {
        async findUserByUsername() {
            calls.userLookups += 1;
            return null;
        },
        async findApprovedCard(id: number) {
            calls.reactionLookups += 1;
            return id === CARD_ID ? { id } : null;
        },
        async incrementReaction() {
            calls.reactionMutations += 1;
        },
        async listReactions() {
            return [];
        }
    } as unknown as BackofficeAuthRepository & ReactionRepository;
    const runtime: RuntimeServices = {
        backofficeAuth: core,
        reactions: core,
        compensation: {
            async enqueue() { return 'unused'; },
            async run() { compensationRuns += 1; }
        },
        rateLimiter: {
            consume(bucket, key, limit, windowSeconds, identity) {
                if (bucket === 'global' && rejectNextGlobal) {
                    rejectNextGlobal = false;
                    return Promise.resolve({
                        allowed: false,
                        remaining: 0,
                        resetAt: Date.now() + windowSeconds * 1000
                    });
                }
                return limiter.consume(bucket, key, limit, windowSeconds, identity);
            }
        },
        storage: {} as ObjectStorage,
        config: { clientAddressSource: 'nginx' }
    };
    const app = createHonoApp(() => runtime);

    await assertAbuseProtectionContract({
        runtime: 'Node',
        cardId: CARD_ID,
        request(path, init = {}) {
            const headers = new Headers(init.headers);
            headers.set('X-Forwarded-For', CLIENT_ADDRESS);
            return Promise.resolve(app.request(`http://ims.test${path}`, { ...init, headers }));
        },
        blockNextGlobal() { rejectNextGlobal = true; },
        async primeRateLimit(bucket, count, limit, windowSeconds) {
            for (let index = 0; index < count; index += 1) {
                const result = await limiter.consume(bucket, CLIENT_ADDRESS, limit, windowSeconds);
                if (!result.allowed) throw new Error(`${bucket} unexpectedly rejected prime request ${index + 1}`);
            }
        },
        async rateLimitCount(bucket) {
            const windows = (limiter as unknown as {
                windows: Map<string, { identities: Set<string> }>;
            }).windows;
            return windows.get(`${bucket}\0${CLIENT_ADDRESS}`)?.identities.size ?? 0;
        },
        compensationCount: () => compensationRuns,
        handlerSnapshot: () => ({ ...calls })
    });
});

test('memory rate limiter sweeps expired identities on the request path', async () => {
    let now = 0;
    const limiter = new MemoryRateLimiter(() => now, 100);
    await limiter.consume('global', 'expired-client', 10, 1);
    now = 2_000;
    await limiter.consume('global', 'active-client', 10, 1);

    const windows = (limiter as unknown as {
        windows: Map<string, { identities: Set<string> }>;
    }).windows;
    assert.equal(windows.has('global\0expired-client'), false);
    assert.equal(windows.has('global\0active-client'), true);
});

test('admin login shares auth throttling and cannot bypass body limits by content type', async () => {
    const limiter = new MemoryRateLimiter();
    let lookups = 0;
    const app = createHonoApp(() => ({
        backofficeAuth: {
            async findUserByUsername() {
                lookups += 1;
                return null;
            }
        } as unknown as BackofficeAuthRepository,
        rateLimiter: limiter,
        config: { clientAddressSource: 'direct' }
    }));

    const oversized = await app.request('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'x'.repeat(JSON_BODY_MAX_BYTES + 1)
    });
    assert.equal(oversized.status, 413);

    const nullBody = await app.request('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'null'
    });
    assert.equal(nullBody.status, 400);
    assert.equal(lookups, 0);

    const windows = (limiter as unknown as {
        windows: Map<string, { identities: Set<string> }>;
    }).windows;
    const authWindow = [...windows.entries()].find(([key]) =>
        key.startsWith('auth-login\0')
    );
    assert.equal(authWindow?.[1].identities.size, 2);
});
