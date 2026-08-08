import type { ImsHonoApp } from '@/app';
import { handleApproveNamecard } from '@/domains/namecards/handlers/approve-namecard';
import { handleDeleteNamecard } from '@/domains/namecards/handlers/delete-namecard';
import { handleGetNamecard } from '@/domains/namecards/handlers/get-namecard';
import { handleListAdminNamecards } from '@/domains/namecards/handlers/list-admin-namecards';
import { handleListNamecards } from '@/domains/namecards/handlers/list-namecards';
import { handleUploadNamecard } from '@/domains/namecards/handlers/upload-namecard';
import { backofficeAuth, backofficeCsrf, opOnly } from '@/middleware/hono-auth';

export function registerNamecardRoutes(app: ImsHonoApp): void {
    app.post('/api/uploadNameCard', handleUploadNamecard);
    app.get('/api/cards', handleListNamecards);
    app.get('/api/card/:id', handleGetNamecard);
    app.get('/api/admin/cards', backofficeAuth, opOnly, handleListAdminNamecards);
    app.post('/api/admin/cards/approve/:id', backofficeAuth, opOnly, backofficeCsrf, handleApproveNamecard);
    app.delete('/api/admin/cards/:id', backofficeAuth, opOnly, backofficeCsrf, handleDeleteNamecard);
}
