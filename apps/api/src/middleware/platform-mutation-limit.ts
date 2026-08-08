import type { Context, MiddlewareHandler, Next } from 'hono';
import type { AppEnvironment } from '@/app';
import { services } from '@/middleware/hono-context';

function limiter(
    bucket: string,
    limit: number
): MiddlewareHandler<AppEnvironment> {
    return async (c: Context<AppEnvironment>, next: Next): Promise<Response | void> => {
        const accountId = c.get('platformUser')?.id;
        const rateLimiter = services(c).rateLimiter;
        if (!accountId || !rateLimiter) {
            await next();
            return;
        }
        const result = await rateLimiter.consume(bucket, accountId, limit, 60 * 60);
        if (!result.allowed) {
            c.header(
                'Retry-After',
                String(Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000)))
            );
            return c.json({ success: false, code: 'PLATFORM_RATE_LIMITED' }, 429);
        }
        await next();
    };
}

export const platformWriteRateLimit = limiter('platform-write-account', 120);
export const platformUploadRateLimit = limiter('platform-upload-account', 30);
export const platformLocationRateLimit = limiter('fudaba-location-account', 12);
