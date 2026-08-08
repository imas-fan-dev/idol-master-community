import type { Context } from 'hono';
import type { AppEnvironment } from '@/app';
import { platformProfileView } from '@/domains/platform-profile/profile-view';
import { services } from '@/middleware/hono-context';

export function handleGetPlatformProfile(c: Context<AppEnvironment>): Response {
    const identity = c.get('platformAccount');
    if (!identity) {
        return c.json({ success: false, code: 'PLATFORM_SESSION_INVALID' }, 401);
    }
    return c.json({
        success: true,
        account: { id: identity.account.id, status: identity.account.status },
        capabilities: {
            fudabaWrite: services(c).config?.fudabaWriteEnabled === true
        },
        profile: platformProfileView(identity.profile)
    });
}
