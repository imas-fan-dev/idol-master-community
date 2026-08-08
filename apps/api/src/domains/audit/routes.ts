import type { ImsHonoApp } from '@/app';
import { handleListAuditLogs } from '@/domains/audit/handlers/list-audit-logs';
import { backofficeAuth, opOnly } from '@/middleware/hono-auth';

export function registerAuditRoutes(app: ImsHonoApp): void {
    app.get('/api/admin/logs', backofficeAuth, opOnly, handleListAuditLogs);
}
