import type { ImsHonoApp } from '@/app';
import { handleCreateNews } from '@/domains/news/handlers/create-news';
import { handleDeleteNews } from '@/domains/news/handlers/delete-news';
import { handleListAdminNews } from '@/domains/news/handlers/list-admin-news';
import { handleListPublicNews } from '@/domains/news/handlers/list-public-news';
import { backofficeAuth, backofficeCsrf, opOnly } from '@/middleware/hono-auth';

export function registerNewsRoutes(app: ImsHonoApp): void {
    app.get('/api/news', handleListPublicNews);
    app.get('/api/admin/news', backofficeAuth, opOnly, handleListAdminNews);
    app.post('/api/admin/news', backofficeAuth, opOnly, backofficeCsrf, handleCreateNews);
    app.delete('/api/admin/news/:id', backofficeAuth, opOnly, backofficeCsrf, handleDeleteNews);
}
