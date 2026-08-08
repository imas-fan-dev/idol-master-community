import type { ImsHonoApp } from '@/app';
import { handleCreateHomepageLink } from '@/domains/homepage-links/handlers/create-homepage-link';
import { handleDeleteHomepageLink } from '@/domains/homepage-links/handlers/delete-homepage-link';
import { handleListHomepageLinks } from '@/domains/homepage-links/handlers/list-homepage-links';
import { handleReorderHomepageLinks } from '@/domains/homepage-links/handlers/reorder-homepage-links';
import { handleUpdateHomepageLink } from '@/domains/homepage-links/handlers/update-homepage-link';
import { backofficeAuth, backofficeCsrf, opOnly } from '@/middleware/hono-auth';

export function registerHomepageLinkRoutes(app: ImsHonoApp): void {
    app.get('/api/homepage-links', handleListHomepageLinks);
    app.get('/api/admin/homepage-links', backofficeAuth, opOnly, handleListHomepageLinks);
    app.post('/api/admin/homepage-links', backofficeAuth, opOnly, backofficeCsrf, handleCreateHomepageLink);
    app.put(
        '/api/admin/homepage-links/:section/order',
        backofficeAuth,
        opOnly,
        backofficeCsrf,
        handleReorderHomepageLinks
    );
    app.put(
        '/api/admin/homepage-links/:id',
        backofficeAuth,
        opOnly,
        backofficeCsrf,
        handleUpdateHomepageLink
    );
    app.delete(
        '/api/admin/homepage-links/:id',
        backofficeAuth,
        opOnly,
        backofficeCsrf,
        handleDeleteHomepageLink
    );
}
