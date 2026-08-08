import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { MemoryRateLimiter } from '@/infra/cache/memory/rate-limiter';
import { SqlFudabaRateLimiter } from '@/infra/cache/sql/fudaba-rate-limiter';
import { PostgresConnection } from '@/infra/db/postgresql/connection';
import type { ManagedSqlDatabase } from '@/infra/db/sql/database';
import {
    PLATFORM_AUTH_LOGIN_ACCOUNT_LIMIT,
    platformLoginAccountRateLimitKey
} from '@/middleware/rate-limit';
import {
    createPostgresTestHarness,
    postgresIntegrationEnabled
} from '../integration/postgres-harness';

interface Fixture {
    database: ManagedSqlDatabase;
    siblingDatabase: ManagedSqlDatabase;
}

async function typescriptFiles(directory: string): Promise<string[]> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const files = await Promise.all(entries.map(async (entry) => {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) return typescriptFiles(absolute);
        return /\.tsx?$/.test(entry.name) ? [absolute] : [];
    }));
    return files.flat();
}

const RATE_LIMIT_SCHEMA = `
    CREATE TABLE IF NOT EXISTS fudaba_rate_limit_windows (
        bucket TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        hits INTEGER NOT NULL,
        window_seconds INTEGER NOT NULL,
        reset_at BIGINT NOT NULL,
        PRIMARY KEY (bucket, key_hash)
    )`;

async function createFixture(
    t: TestContext,
    dialect: 'sqlite' | 'postgresql'
): Promise<Fixture> {
    const harness = await createPostgresTestHarness();
    const siblingDatabase = PostgresConnection.create({
        connectionString: harness.databaseUrl,
        maxConnections: 4,
        idleTimeoutMs: 5_000,
        connectionTimeoutMs: 5_000,
        statementTimeoutMs: 30_000,
        idleInTransactionTimeoutMs: 30_000
    });
    t.after(async () => {
        await siblingDatabase.close();
        await harness.close();
    });
    await harness.connection.executeScript(RATE_LIMIT_SCHEMA);
    return { database: harness.connection, siblingDatabase };
}

async function assertPersistentRateLimiterContract(
    t: TestContext,
    dialect: 'sqlite' | 'postgresql'
): Promise<void> {
    const fixture = await createFixture(t, dialect);
    let now = 1_800_000_000_000;
    const clock = (): number => now;
    const first = new SqlFudabaRateLimiter(
        fixture.database,
        new MemoryRateLimiter(),
        clock
    );
    const sibling = new SqlFudabaRateLimiter(
        fixture.siblingDatabase,
        new MemoryRateLimiter(),
        clock
    );
    const key = '203.0.113.42';
    const limit = 20;

    const attempts = await Promise.all(Array.from({ length: 80 }, (_, index) =>
        (index % 2 ? first : sibling).consume('fudaba-map-ip', key, limit, 60)
    ));
    assert.equal(attempts.filter((result) => result.allowed).length, limit);
    assert.equal(attempts.filter((result) => !result.allowed).length, 80 - limit);

    const stored = await fixture.database.prepare(
        `SELECT key_hash, hits, window_seconds, reset_at
         FROM fudaba_rate_limit_windows
         WHERE bucket='fudaba-map-ip'`
    ).first<{
        key_hash: string;
        hits: number;
        window_seconds: number;
        reset_at: number;
    }>();
    assert.deepEqual(stored, {
        key_hash: crypto.createHash('sha256').update(key).digest('hex'),
        hits: limit,
        window_seconds: 60,
        reset_at: now + 60_000
    });
    assert.notEqual(stored?.key_hash, key);

    const reconstructed = new SqlFudabaRateLimiter(
        fixture.database,
        new MemoryRateLimiter(),
        clock
    );
    const stillBlocked = await reconstructed.consume('fudaba-map-ip', key, limit, 60);
    assert.deepEqual(stillBlocked, {
        allowed: false,
        remaining: 0,
        resetAt: now + 60_000
    });

    now += 60_000;
    assert.deepEqual(
        await sibling.consume('fudaba-map-ip', key, limit, 60),
        { allowed: true, remaining: limit - 1, resetAt: now + 60_000 }
    );
    now += 1;
    assert.deepEqual(
        await first.consume('fudaba-map-ip', key, limit, 120),
        { allowed: true, remaining: limit - 1, resetAt: now + 120_000 }
    );
}

test('PostgreSQL shares hashed Fudaba windows atomically across limiter instances', {
    skip: !postgresIntegrationEnabled()
}, async (t) => {
    await assertPersistentRateLimiterContract(t, 'postgresql');
});

async function assertPlatformLoginAccountLimiterContract(
    t: TestContext,
    dialect: 'sqlite' | 'postgresql'
): Promise<void> {
    const fixture = await createFixture(t, dialect);
    const first = new SqlFudabaRateLimiter(fixture.database, new MemoryRateLimiter());
    const sibling = new SqlFudabaRateLimiter(
        fixture.siblingDatabase,
        new MemoryRateLimiter()
    );
    const normalizedEmail = 'targeted-producer@example.test';
    const accountKey = platformLoginAccountRateLimitKey(normalizedEmail);
    const options = PLATFORM_AUTH_LOGIN_ACCOUNT_LIMIT;

    const attempts = await Promise.all(Array.from({ length: options.limit + 30 }, (_, index) =>
        (index % 2 ? first : sibling).consume(
            options.bucket,
            accountKey,
            options.limit,
            options.windowSeconds
        )
    ));
    assert.equal(attempts.filter((result) => result.allowed).length, options.limit);
    assert.equal(attempts.filter((result) => !result.allowed).length, 30);

    const stored = await fixture.database.prepare(
        `SELECT bucket, key_hash, hits, window_seconds
         FROM fudaba_rate_limit_windows
         WHERE bucket=?`
    ).bind(options.bucket).first<{
        bucket: string;
        key_hash: string;
        hits: number;
        window_seconds: number;
    }>();
    assert.ok(stored);
    assert.deepEqual(stored, {
        bucket: options.bucket,
        key_hash: crypto.createHash('sha256').update(accountKey).digest('hex'),
        hits: options.limit,
        window_seconds: options.windowSeconds
    });
    assert.match(accountKey, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(stored), new RegExp(normalizedEmail, 'i'));
    assert.notEqual(stored.key_hash, accountKey);
}

test('PostgreSQL shares the platform login account bucket without storing email PII', {
    skip: !postgresIntegrationEnabled()
}, async (t) => {
    await assertPlatformLoginAccountLimiterContract(t, 'postgresql');
});

test('only selected buckets without identities use persistent windows', async (t) => {
    const fixture = await createFixture(t, 'postgresql');
    const first = new SqlFudabaRateLimiter(fixture.database, new MemoryRateLimiter());
    const sibling = new SqlFudabaRateLimiter(
        fixture.siblingDatabase,
        new MemoryRateLimiter()
    );

    for (const bucket of [
        'fudaba-location-account',
        'platform-auth-email-verification',
        'platform-auth-login',
        'platform-auth-login-account',
        'platform-auth-register',
        'platform-write-account',
        'platform-upload-account'
    ]) {
        assert.equal((await first.consume(bucket, 'account-1', 1, 60)).allowed, true);
        assert.equal((await sibling.consume(bucket, 'account-1', 1, 60)).allowed, false);
    }

    assert.equal((await first.consume('global', 'shared-ip', 1, 60)).allowed, true);
    assert.equal((await sibling.consume('global', 'shared-ip', 1, 60)).allowed, true);

    const identity = { operation: 'fudaba:upload', identity: 'request-1' };
    assert.equal(
        (await first.consume('fudaba-upload-write', 'account-2', 1, 60, identity)).allowed,
        true
    );
    assert.equal(
        (await first.consume('fudaba-upload-write', 'account-2', 1, 60, identity)).allowed,
        true
    );
    assert.equal(
        (await first.consume('fudaba-upload-write', 'account-2', 1, 60, {
            ...identity,
            identity: 'request-2'
        })).allowed,
        false
    );
    assert.equal(
        await fixture.database.prepare(
            `SELECT COUNT(*) AS count FROM fudaba_rate_limit_windows`
        ).first<number>('count'),
        7
    );
});

test('expired windows are cleaned at most once per limiter every five minutes', async (t) => {
    const fixture = await createFixture(t, 'postgresql');
    let now = 1_800_000_000_000;
    const limiter = new SqlFudabaRateLimiter(
        fixture.database,
        new MemoryRateLimiter(),
        () => now
    );
    const insertExpiredWindow = (keyHash: string) => fixture.database.prepare(
        `INSERT INTO fudaba_rate_limit_windows
            (bucket, key_hash, hits, window_seconds, reset_at)
         VALUES ('fudaba-map-ip', ?, 1, 60, ?)`
    ).bind(keyHash, now - 1).run();
    const storedWindow = (keyHash: string) => fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM fudaba_rate_limit_windows
         WHERE key_hash=?`
    ).bind(keyHash).first<number>('count');

    const staleBeforeCleanup = 'a'.repeat(64);
    await insertExpiredWindow(staleBeforeCleanup);
    assert.deepEqual(
        await limiter.consume('fudaba-map-ip', 'current-1', 2, 60),
        { allowed: true, remaining: 1, resetAt: now + 60_000 }
    );
    assert.equal(await storedWindow(staleBeforeCleanup), 0);

    const staleDuringThrottle = 'b'.repeat(64);
    await insertExpiredWindow(staleDuringThrottle);
    assert.equal(
        (await limiter.consume('fudaba-map-ip', 'current-2', 2, 60)).allowed,
        true
    );
    assert.equal(await storedWindow(staleDuringThrottle), 1);

    now += 5 * 60 * 1000;
    assert.equal(
        (await limiter.consume('fudaba-map-ip', 'current-3', 2, 60)).allowed,
        true
    );
    assert.equal(await storedWindow(staleDuringThrottle), 0);
});

test('cleanup database failures fail closed and are retried', async (t) => {
    const fixture = await createFixture(t, 'postgresql');
    const now = 1_800_000_000_000;
    const limiter = new SqlFudabaRateLimiter(
        fixture.database,
        new MemoryRateLimiter(),
        () => now
    );
    await fixture.database.prepare(
        `INSERT INTO fudaba_rate_limit_windows
            (bucket, key_hash, hits, window_seconds, reset_at)
         VALUES ('fudaba-map-ip', ?, 1, 60, ?)`
    ).bind('c'.repeat(64), now - 1).run();
    await fixture.database.executeScript(`
        CREATE FUNCTION fail_rate_limit_cleanup() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'injected cleanup failure';
        END;
        $$;
        CREATE TRIGGER fail_rate_limit_cleanup
        BEFORE DELETE ON fudaba_rate_limit_windows
        FOR EACH ROW EXECUTE FUNCTION fail_rate_limit_cleanup();
    `);

    await assert.rejects(
        limiter.consume('fudaba-map-ip', 'current-key', 2, 60),
        /injected cleanup failure/
    );
    assert.equal(
        await fixture.database.prepare(
            `SELECT COUNT(*) AS count FROM fudaba_rate_limit_windows
             WHERE bucket='fudaba-map-ip'`
        ).first<number>('count'),
        1
    );

    await fixture.database.executeScript(`
        DROP TRIGGER fail_rate_limit_cleanup ON fudaba_rate_limit_windows;
        DROP FUNCTION fail_rate_limit_cleanup();
    `);
    assert.deepEqual(
        await limiter.consume('fudaba-map-ip', 'current-key', 2, 60),
        { allowed: true, remaining: 1, resetAt: now + 60_000 }
    );
});

test('domain and middleware code cannot depend on the SQL rate limiter', async () => {
    const sourceRoot = path.resolve(__dirname, '../../src');
    const files = (
        await Promise.all(['domains', 'middleware'].map((directory) =>
            typescriptFiles(path.join(sourceRoot, directory))
        ))
    ).flat();
    for (const file of files) {
        const source = await fs.readFile(file, 'utf8');
        assert.doesNotMatch(
            source,
            /['"]@\/infra\/cache\/sql\/fudaba-rate-limiter['"]/,
            `${path.relative(sourceRoot, file)} must depend on the RateLimiter port`
        );
    }
});
