import type { Context, Next } from 'hono';
import type { AppEnvironment, ImsHonoApp } from '@/app';
import { handleGetFudabaPublicOffice } from '@/domains/fudaba/handlers/get-public-office';
import { handleCreateFudabaCard } from '@/domains/fudaba/handlers/create-card';
import { handleCreateFudabaOffice } from '@/domains/fudaba/handlers/create-office';
import { handleDeleteFudabaCard } from '@/domains/fudaba/handlers/delete-card';
import { handleArchiveFudabaOwnerOffice } from '@/domains/fudaba/handlers/archive-owner-office';
import { handleGetFudabaOwnerCard } from '@/domains/fudaba/handlers/get-owner-card';
import { handleGetFudabaOwnerOffice } from '@/domains/fudaba/handlers/get-owner-office';
import { handleListFudabaPublicCards } from '@/domains/fudaba/handlers/list-public-cards';
import { handleListFudabaPublicOffices } from '@/domains/fudaba/handlers/list-public-offices';
import { handleListFudabaPublicSeries } from '@/domains/fudaba/handlers/list-public-series';
import { handleListFudabaOwnerCards } from '@/domains/fudaba/handlers/list-owner-cards';
import { handleListFudabaOwnerOffices } from '@/domains/fudaba/handlers/list-owner-offices';
import { handleGetFudabaMapConfig } from '@/domains/fudaba/handlers/get-map-config';
import { handleGetFudabaOwnerLocation } from '@/domains/fudaba/handlers/get-owner-location';
import { handleListFudabaLocationReviews } from '@/domains/fudaba/handlers/list-location-reviews';
import { handleListFudabaMapOffices } from '@/domains/fudaba/handlers/list-map-offices';
import { handleReviewFudabaLocation } from '@/domains/fudaba/handlers/review-location';
import { handleRemoveFudabaCardPlacement } from '@/domains/fudaba/handlers/remove-card-placement';
import { handleSaveFudabaCardPlacement } from '@/domains/fudaba/handlers/save-card-placement';
import { handleSaveFudabaOwnerLocation } from '@/domains/fudaba/handlers/save-owner-location';
import { handleServeFudabaOwnerCardMedia } from '@/domains/fudaba/handlers/serve-owner-card-media';
import {
    handleServeFudabaOwnerOfficeCover,
    handleServeFudabaOwnerOfficePendingCover
} from '@/domains/fudaba/handlers/serve-owner-office-media';
import { handleRestoreFudabaOwnerOffice } from '@/domains/fudaba/handlers/restore-owner-office';
import { handleUpdateFudabaCard } from '@/domains/fudaba/handlers/update-card';
import { handleUpdateFudabaOwnerOffice } from '@/domains/fudaba/handlers/update-owner-office';
import { handleUploadFudabaOfficeCover } from '@/domains/fudaba/handlers/upload-office-cover';
import { handleUploadFudabaOwnedMedia } from '@/domains/fudaba/handlers/upload-owned-media';
import { handleWithdrawFudabaOfficeCover } from '@/domains/fudaba/handlers/withdraw-office-cover';
import { handleWithdrawFudabaOwnerLocation } from '@/domains/fudaba/handlers/withdraw-owner-location';
import {
    activePlatformMutation,
    backofficeAuth,
    backofficeCsrf,
    currentBackofficeOp,
    optionalPlatformAuth,
    platformAuth,
    platformCsrf
} from '@/middleware/hono-auth';
import { services } from '@/middleware/hono-context';
import {
    platformLocationRateLimit,
    platformUploadRateLimit,
    platformWriteRateLimit
} from '@/middleware/platform-mutation-limit';

async function privateFudabaResponse(
    c: Context<AppEnvironment>,
    next: Next
): Promise<void> {
    await next();
    c.header('Cache-Control', 'private, no-store');
    c.header('Vary', 'Authorization, Cookie', { append: true });
}

async function requireFudabaPublicRead(
    c: Context<AppEnvironment>,
    next: Next
): Promise<Response | void> {
    if (services(c).config?.fudabaPublicReadEnabled !== true) {
        return c.text('Not Found', 404);
    }
    await next();
}

async function requireFudabaWrite(
    c: Context<AppEnvironment>,
    next: Next
): Promise<Response | void> {
    if (services(c).config?.fudabaWriteEnabled !== true) {
        return c.text('Not Found', 404);
    }
    await next();
}

async function requireFudabaMap(
    c: Context<AppEnvironment>,
    next: Next
): Promise<Response | void> {
    if (services(c).config?.fudabaMapEnabled !== true) {
        return c.text('Not Found', 404);
    }
    await next();
}

export function registerFudabaRoutes(app: ImsHonoApp): void {
    app.use('/api/community/exchange/*', privateFudabaResponse);
    app.use('/api/admin/community/exchange/*', privateFudabaResponse);
    app.get(
        '/api/community/exchange/series',
        requireFudabaPublicRead,
        optionalPlatformAuth,
        handleListFudabaPublicSeries
    );
    app.get(
        '/api/community/exchange/offices',
        requireFudabaPublicRead,
        optionalPlatformAuth,
        handleListFudabaPublicOffices
    );
    app.get(
        '/api/community/exchange/offices/:officeSlug',
        requireFudabaPublicRead,
        optionalPlatformAuth,
        handleGetFudabaPublicOffice
    );
    app.get(
        '/api/community/exchange/cards',
        requireFudabaPublicRead,
        optionalPlatformAuth,
        handleListFudabaPublicCards
    );
    app.get(
        '/api/community/exchange/map/config',
        requireFudabaPublicRead,
        requireFudabaMap,
        optionalPlatformAuth,
        handleGetFudabaMapConfig
    );
    app.get(
        '/api/community/exchange/map/offices',
        requireFudabaPublicRead,
        requireFudabaMap,
        optionalPlatformAuth,
        handleListFudabaMapOffices
    );
    app.get(
        '/api/community/exchange/me/series',
        platformAuth,
        handleListFudabaPublicSeries
    );
    app.get(
        '/api/community/exchange/me/cards',
        platformAuth,
        handleListFudabaOwnerCards
    );
    app.get(
        '/api/community/exchange/me/cards/:cardId',
        platformAuth,
        handleGetFudabaOwnerCard
    );
    app.get(
        '/api/community/exchange/me/offices',
        platformAuth,
        handleListFudabaOwnerOffices
    );
    app.get(
        '/api/community/exchange/me/offices/:officeId',
        platformAuth,
        handleGetFudabaOwnerOffice
    );
    app.get(
        '/api/community/exchange/me/offices/:officeId/location',
        platformAuth,
        handleGetFudabaOwnerLocation
    );
    app.get(
        '/api/community/exchange/me/cards/:cardId/media/:side',
        platformAuth,
        handleServeFudabaOwnerCardMedia
    );
    app.on(
        'HEAD',
        '/api/community/exchange/me/cards/:cardId/media/:side',
        platformAuth,
        handleServeFudabaOwnerCardMedia
    );
    app.get(
        '/api/community/exchange/me/offices/:officeId/media/cover',
        platformAuth,
        handleServeFudabaOwnerOfficeCover
    );
    app.on(
        'HEAD',
        '/api/community/exchange/me/offices/:officeId/media/cover',
        platformAuth,
        handleServeFudabaOwnerOfficeCover
    );
    app.get(
        '/api/community/exchange/me/offices/:officeId/media/pending-cover',
        platformAuth,
        handleServeFudabaOwnerOfficePendingCover
    );
    app.on(
        'HEAD',
        '/api/community/exchange/me/offices/:officeId/media/pending-cover',
        platformAuth,
        handleServeFudabaOwnerOfficePendingCover
    );
    const write = [
        requireFudabaWrite,
        platformAuth,
        activePlatformMutation,
        platformCsrf,
        platformWriteRateLimit
    ] as const;
    const locationWrite = [
        requireFudabaWrite,
        platformAuth,
        activePlatformMutation,
        platformCsrf,
        platformLocationRateLimit,
        platformWriteRateLimit
    ] as const;
    app.post(
        '/api/community/exchange/cards',
        requireFudabaWrite,
        platformAuth,
        activePlatformMutation,
        platformCsrf,
        platformUploadRateLimit,
        platformWriteRateLimit,
        handleCreateFudabaCard
    );
    app.post(
        '/api/community/exchange/offices',
        ...write,
        handleCreateFudabaOffice
    );
    app.put(
        '/api/community/exchange/me/cards/:cardId',
        ...write,
        handleUpdateFudabaCard
    );
    app.delete(
        '/api/community/exchange/me/cards/:cardId',
        ...write,
        handleDeleteFudabaCard
    );
    app.put(
        '/api/community/exchange/offices/:officeId/cards/:cardId/placement',
        ...write,
        handleSaveFudabaCardPlacement
    );
    app.delete(
        '/api/community/exchange/offices/:officeId/cards/:cardId/placement',
        ...write,
        handleRemoveFudabaCardPlacement
    );
    app.put(
        '/api/community/exchange/me/offices/:officeId',
        ...write,
        handleUpdateFudabaOwnerOffice
    );
    app.delete(
        '/api/community/exchange/me/offices/:officeId',
        ...write,
        handleArchiveFudabaOwnerOffice
    );
    app.post(
        '/api/community/exchange/me/offices/:officeId/restore',
        ...write,
        handleRestoreFudabaOwnerOffice
    );
    app.put(
        '/api/community/exchange/me/offices/:officeId/cover',
        requireFudabaWrite,
        platformAuth,
        activePlatformMutation,
        platformCsrf,
        platformUploadRateLimit,
        platformWriteRateLimit,
        handleUploadFudabaOfficeCover
    );
    app.delete(
        '/api/community/exchange/me/offices/:officeId/cover/pending',
        ...write,
        handleWithdrawFudabaOfficeCover
    );
    app.put(
        '/api/community/exchange/me/offices/:officeId/location',
        ...locationWrite,
        handleSaveFudabaOwnerLocation
    );
    app.delete(
        '/api/community/exchange/me/offices/:officeId/location',
        ...locationWrite,
        handleWithdrawFudabaOwnerLocation
    );
    app.put(
        '/api/community/exchange/uploads/:side',
        requireFudabaWrite,
        platformAuth,
        activePlatformMutation,
        platformCsrf,
        platformUploadRateLimit,
        handleUploadFudabaOwnedMedia
    );
    app.get(
        '/api/admin/community/exchange/office-locations',
        backofficeAuth,
        currentBackofficeOp,
        handleListFudabaLocationReviews
    );
    app.put(
        '/api/admin/community/exchange/office-locations/:officeId',
        backofficeAuth,
        currentBackofficeOp,
        backofficeCsrf,
        handleReviewFudabaLocation
    );
}
