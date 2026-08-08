import type { ImsHonoApp } from '@/app';
import { handleCreateAdminAccount } from '@/domains/admin-accounts/handlers/create-admin-account';
import { handleDeleteAdminAccount } from '@/domains/admin-accounts/handlers/delete-admin-account';
import { handleListAdminAccounts } from '@/domains/admin-accounts/handlers/list-admin-accounts';
import { backofficeAuth, backofficeCsrf, opOnly, superAdminOnly } from '@/middleware/hono-auth';

export function registerAdminAccountRoutes(app: ImsHonoApp): void {
    app.get(
        '/api/admin/accounts',
        backofficeAuth,
        opOnly,
        superAdminOnly,
        handleListAdminAccounts
    );
    app.post(
        '/api/admin/accounts',
        backofficeAuth,
        opOnly,
        superAdminOnly,
        backofficeCsrf,
        handleCreateAdminAccount
    );
    app.delete(
        '/api/admin/accounts/:id',
        backofficeAuth,
        opOnly,
        superAdminOnly,
        backofficeCsrf,
        handleDeleteAdminAccount
    );
}
