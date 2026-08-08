import type { Context } from 'hono';
import type { AppEnvironment } from '@/app';

export function handleCheckBackofficeAuth(c: Context<AppEnvironment>): Response {
    return c.json({ success: true, user: c.get('backofficeUser') });
}
