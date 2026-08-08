import type { Context } from 'hono';
import type { AppEnvironment } from '@/app';
import { assertNoFudabaQuery } from '@/domains/fudaba/public-read';
import { services } from '@/middleware/hono-context';

export async function handleGetFudabaMapConfig(
    c: Context<AppEnvironment>
): Promise<Response> {
    assertNoFudabaQuery(c.req.url);
    const styleUrl = services(c).config?.fudabaMapStyleUrl;
    if (!styleUrl) {
        throw Object.assign(new Error('Fudaba map style is unavailable'), { status: 503 });
    }
    return c.json({ styleUrl });
}
