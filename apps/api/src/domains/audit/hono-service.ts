import type { Context } from 'hono';
import type { AppEnvironment } from '@/app';
import { auditRepository, getClientAddress } from '@/middleware/hono-context';

export async function writeAudit(
    c: Context<AppEnvironment>,
    action: string,
    target: string
): Promise<void> {
    const user = c.get('backofficeUser');
    try {
        await auditRepository(c).insertAuditLog({
            username: user?.username || 'anonymous',
            producername: user?.producername || '',
            action,
            target,
            ip: getClientAddress(c),
            time: new Date().toISOString()
        });
    } catch (error) {
        console.error(error);
    }
}
