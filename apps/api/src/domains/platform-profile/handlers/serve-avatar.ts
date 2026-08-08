import type { Context } from 'hono';
import type { AppEnvironment } from '@/app';
import { services } from '@/middleware/hono-context';
import { objectReadResponse } from '@/utils/http/object-read-response';

export async function handleServePlatformAvatar(
    c: Context<AppEnvironment>
): Promise<Response> {
    const key = c.get('platformAccount')?.profile.avatar_object_key;
    if (!key) return c.text('Not Found', 404);
    const storage = services(c).storage;
    if (!storage) throw new Error('Object storage unavailable');
    const response = await objectReadResponse(c.req.raw, storage, key, {
        'Cache-Control': 'private, no-store',
        'Vary': 'Authorization, Cookie'
    });
    return response ?? c.text('Not Found', 404);
}
