import type { Context } from 'hono';
import type { AppEnvironment } from '@/app';
import { platformSessionPayload } from '@/domains/platform-auth/platform-auth-session';

export async function handlePlatformSession(c: Context<AppEnvironment>): Promise<Response> {
    return c.json(await platformSessionPayload(c, c.get('platformAccount')!));
}
