import type { ImsHonoApp } from '@/app';
import { handleGetAboutPage } from '@/domains/about/handlers/get-about-page';
import { handleGetAdminAboutPage } from '@/domains/about/handlers/get-admin-about-page';
import { handleUploadAboutHeroImage } from '@/domains/about/handlers/upload-about-hero-image';
import { handleUploadAboutMemberAvatar } from '@/domains/about/handlers/upload-about-member-avatar';
import { handleUpdateAboutPage } from '@/domains/about/handlers/update-about-page';
import { backofficeAuth, backofficeCsrf, opOnly } from '@/middleware/hono-auth';

export function registerAboutRoutes(app: ImsHonoApp): void {
    app.get('/api/about', handleGetAboutPage);
    app.get('/api/admin/about', backofficeAuth, opOnly, handleGetAdminAboutPage);
    app.post(
        '/api/admin/about/hero-image',
        backofficeAuth,
        opOnly,
        backofficeCsrf,
        handleUploadAboutHeroImage
    );
    app.post(
        '/api/admin/about/member-avatar',
        backofficeAuth,
        opOnly,
        backofficeCsrf,
        handleUploadAboutMemberAvatar
    );
    app.put('/api/admin/about', backofficeAuth, opOnly, backofficeCsrf, handleUpdateAboutPage);
}
