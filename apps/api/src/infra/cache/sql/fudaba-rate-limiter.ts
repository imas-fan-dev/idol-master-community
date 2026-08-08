import crypto from 'node:crypto';
import type { ManagedSqlDatabase } from '@/infra/db/sql/database';
import type {
    RateLimiter,
    RateLimitIdentity,
    RateLimitResult
} from '@/ports/cache';

interface RateLimitWindowRow {
    hits: number;
    reset_at: number;
}

const PERSISTENT_BUCKETS = new Set([
    'platform-auth-email-verification',
    'platform-auth-login',
    'platform-auth-login-account',
    'platform-auth-register',
    'platform-write-account',
    'platform-upload-account'
]);
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

const CONSUME_WINDOW_SQL = `
    INSERT INTO fudaba_rate_limit_windows
        (bucket, key_hash, hits, window_seconds, reset_at)
    VALUES (?, ?, 1, ?, ?)
    ON CONFLICT(bucket, key_hash) DO UPDATE SET
        hits=CASE
            WHEN fudaba_rate_limit_windows.reset_at<=?
              OR fudaba_rate_limit_windows.window_seconds<>excluded.window_seconds
            THEN 1
            ELSE fudaba_rate_limit_windows.hits+1
        END,
        window_seconds=excluded.window_seconds,
        reset_at=CASE
            WHEN fudaba_rate_limit_windows.reset_at<=?
              OR fudaba_rate_limit_windows.window_seconds<>excluded.window_seconds
            THEN excluded.reset_at
            ELSE fudaba_rate_limit_windows.reset_at
        END
    WHERE fudaba_rate_limit_windows.reset_at<=?
       OR fudaba_rate_limit_windows.window_seconds<>excluded.window_seconds
       OR fudaba_rate_limit_windows.hits<?
    RETURNING hits, reset_at`;

function shouldPersist(bucket: string): boolean {
    return bucket.startsWith('fudaba-') || PERSISTENT_BUCKETS.has(bucket);
}

function hashRateLimitKey(key: string): string {
    return crypto.createHash('sha256').update(key).digest('hex');
}

export class SqlFudabaRateLimiter implements RateLimiter {
    private cleanupAfter = 0;
    private cleanupPromise?: Promise<void>;

    constructor(
        private readonly database: ManagedSqlDatabase,
        private readonly memory: RateLimiter,
        private readonly now: () => number = Date.now
    ) {}

    async consume(
        bucket: string,
        key: string,
        limit: number,
        windowSeconds: number,
        identity?: RateLimitIdentity
    ): Promise<RateLimitResult> {
        if (identity || !shouldPersist(bucket)) {
            return this.memory.consume(bucket, key, limit, windowSeconds, identity);
        }

        const now = this.now();
        await this.cleanupExpiredWindows(now);
        const keyHash = hashRateLimitKey(key);
        const resetAt = now + windowSeconds * 1000;
        const row = await this.database.prepare(CONSUME_WINDOW_SQL).bind(
            bucket,
            keyHash,
            windowSeconds,
            resetAt,
            now,
            now,
            now,
            limit
        ).first<RateLimitWindowRow>();

        if (row) {
            return {
                allowed: true,
                remaining: Math.max(0, limit - Number(row.hits)),
                resetAt: Number(row.reset_at)
            };
        }

        const blockedWindow = await this.database.prepare(
            `SELECT hits, reset_at
             FROM fudaba_rate_limit_windows
             WHERE bucket=? AND key_hash=?`
        ).bind(bucket, keyHash).first<RateLimitWindowRow>();
        if (!blockedWindow) {
            throw new Error('Rate-limit window disappeared after a blocked consume');
        }
        return {
            allowed: false,
            remaining: 0,
            resetAt: Number(blockedWindow.reset_at)
        };
    }

    private cleanupExpiredWindows(now: number): Promise<void> {
        if (now < this.cleanupAfter) return Promise.resolve();
        if (this.cleanupPromise) return this.cleanupPromise;

        const cleanup = this.database.prepare(
            'DELETE FROM fudaba_rate_limit_windows WHERE reset_at<=?'
        ).bind(now).run().then(() => {
            this.cleanupAfter = now + CLEANUP_INTERVAL_MS;
        }).finally(() => {
            if (this.cleanupPromise === cleanup) this.cleanupPromise = undefined;
        });
        this.cleanupPromise = cleanup;
        return cleanup;
    }
}
