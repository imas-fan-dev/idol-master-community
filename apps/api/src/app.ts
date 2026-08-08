import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { requestId, type RequestIdVariables } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import { jsonBodyLimit } from '@/middleware/json-body-limit';
import {
    isDynamicBusinessRequest,
    requestRateLimit,
    validatedRequestPath
} from '@/middleware/rate-limit';
import type { RuntimeServices, ResolveServices } from '@/ports/runtime-services';
import type { BackofficeJwtClaims, PlatformJwtClaims } from '@/ports/security';
import type { PlatformAccountWithProfile } from '@/ports/repositories';
import { requestCompletionLogger } from '@/middleware/request-observability';
import { isSensitiveRequestPath } from '@/middleware/static-path-policy';
import { registerAuditRoutes } from '@/domains/audit/routes';
import { registerAdminAccountRoutes } from '@/domains/admin-accounts/routes';
import { registerAboutRoutes } from '@/domains/about/routes';
import { registerBackofficeAuthRoutes } from '@/domains/backoffice-auth/routes';
import { registerBrandAssetRoutes } from '@/domains/brand-assets/routes';
import { registerChronicleRoutes } from '@/domains/chronicle/routes';
import { registerEventRoutes } from '@/domains/events/routes';
import { registerFudabaRoutes } from '@/domains/fudaba/routes';
import { registerInformationRoutes } from '@/domains/information/routes';
import { registerHomepageLinkRoutes } from '@/domains/homepage-links/routes';
import { registerLiveScheduleRoutes } from '@/domains/live-schedule/routes';
import { registerMediaRoutes } from '@/domains/media/routes';
import { registerNamecardRoutes } from '@/domains/namecards/routes';
import { registerNewsRoutes } from '@/domains/news/routes';
import { registerProducerMapRoutes } from '@/domains/producer-map/routes';
import { registerPlatformAuthRoutes } from '@/domains/platform-auth/routes';
import { registerPlatformProfileRoutes } from '@/domains/platform-profile/routes';
import { registerReactionRoutes } from '@/domains/reactions/routes';
import { registerSiteRoutes } from '@/domains/site/routes';
import { registerSitePackageRoutes } from '@/domains/site-packages/routes';
import { registerWikiRoutes } from '@/domains/wiki/index';

export interface AppEnvironment {
    Bindings: object;
    Variables: RequestIdVariables & {
        services: RuntimeServices;
        backofficeUser?: BackofficeJwtClaims;
        backofficeAuthSource?: 'authorization' | 'cookie' | 'legacy-cookie';
        platformUser?: PlatformJwtClaims;
        platformAccount?: PlatformAccountWithProfile;
        platformAuthSource?: 'authorization' | 'cookie';
    };
}

export type ImsHonoApp = Hono<AppEnvironment>;

export interface CreateHonoAppOptions {
    requestLogging?: boolean;
}

export function createHonoApp<Bindings extends object = Record<string, unknown>>(
    resolveServices: ResolveServices<Bindings>,
    options: CreateHonoAppOptions = {}
): ImsHonoApp {
    const app = new Hono<AppEnvironment>();

    app.use('*', requestId({ limitLength: 128 }));
    app.use('*', requestCompletionLogger(options.requestLogging === true));
    app.use('*', async (c, next) => {
        if (c.req.path === '/api/health/live' || c.req.path === '/api/wiki/test') {
            return next();
        }
        let runtime: RuntimeServices;
        try {
            runtime = await resolveServices(c.env as Bindings);
        } catch (error) {
            if (c.req.path === '/api/health/ready') {
                if (options.requestLogging) {
                    console.warn(JSON.stringify({
                        event: 'health_readiness_failed',
                        requestId: c.get('requestId'),
                        error: error instanceof Error ? error.message : String(error)
                    }));
                }
                return c.json({ status: 'unavailable' }, 503);
            }
            throw error;
        }
        c.set('services', runtime);
        await next();
    });

    app.use('*', async (c, next) => {
        const rawPath = new URL(c.req.raw.url).pathname;
        if (isSensitiveRequestPath(rawPath)) {
            return c.text('Forbidden', 403);
        }
        await next();
    });

    app.use('*', cors());
    app.use('*', secureHeaders({
        crossOriginEmbedderPolicy: false,
        crossOriginResourcePolicy: 'cross-origin',
        strictTransportSecurity: 'max-age=31536000; includeSubDomains',
        xFrameOptions: false
    }));
    app.use('*', async (c, next) => {
        await next();
        const pathname = new URL(c.req.raw.url).pathname;
        if (
            pathname !== '/site-content' &&
            !pathname.startsWith('/site-content/') &&
            !c.res.headers.has('X-Frame-Options')
        ) {
            c.header('X-Frame-Options', 'SAMEORIGIN');
        }
    });
    app.use('/api/platform/auth/*', async (c, next) => {
        await next();
        c.header('Cache-Control', 'private, no-store');
        c.header('Vary', 'Authorization, Cookie', { append: true });
    });
    app.use('*', requestRateLimit());
    app.use('*', jsonBodyLimit());
    app.use('*', async (c, next) => {
        const pathname = validatedRequestPath(c);
        const runtime = c.get('services');
        if (
            isDynamicBusinessRequest(c.req.method, pathname) &&
            runtime.compensation && runtime.storage
        ) {
            await runtime.compensation.run(runtime.storage, 3).catch((error) => console.warn(error));
        }
        await next();
    });

    app.get('/api/health/live', (c) => c.json({ status: 'ok' }));
    app.get('/api/health/ready', async (c) => {
        const health = c.get('services').health;
        if (!health) return c.json({ status: 'unavailable' }, 503);
        try {
            await health.check();
            return c.json({ status: 'ok' });
        } catch (error) {
            if (options.requestLogging) {
                console.warn(JSON.stringify({
                    event: 'health_readiness_failed',
                    requestId: c.get('requestId'),
                    error: error instanceof Error ? error.message : String(error)
                }));
            }
            return c.json({ status: 'unavailable' }, 503);
        }
    });

    // Kept as a compatibility probe for existing clients.
    app.get('/api/wiki/test', (c) => c.json({ status: 'ok' }));

    registerReactionRoutes(app);
    registerAboutRoutes(app);
    registerProducerMapRoutes(app);
    registerBrandAssetRoutes(app);
    registerBackofficeAuthRoutes(app);
    registerPlatformAuthRoutes(app);
    registerPlatformProfileRoutes(app);
    registerAdminAccountRoutes(app);
    registerNamecardRoutes(app);
    registerEventRoutes(app);
    registerFudabaRoutes(app);
    registerNewsRoutes(app);
    registerHomepageLinkRoutes(app);
    registerInformationRoutes(app);
    registerLiveScheduleRoutes(app);
    registerMediaRoutes(app);
    registerAuditRoutes(app);
    registerChronicleRoutes(app);
    registerSitePackageRoutes(app);
    registerSiteRoutes(app);
    registerWikiRoutes(app, (c) => c.get('services'));

    app.notFound(async (c) => {
        const assets = c.get('services').staticAssets;
        return assets ? assets.fetch(c.req.raw) : c.text('Not Found', 404);
    });

    app.onError((error, c) => {
        const candidate = Number((error as Error & { status?: unknown }).status);
        const status = Number.isInteger(candidate) && candidate >= 400 && candidate <= 599
            ? candidate
            : 500;
        if (status >= 500 && options.requestLogging) {
            console.error(JSON.stringify({
                event: 'http_request_error',
                requestId: c.get('requestId'),
                method: c.req.method,
                path: c.req.path,
                status,
                error: error.message,
                stack: error.stack
            }));
        }
        return new Response(JSON.stringify({
            error: status >= 500 ? 'Internal server error' : error.message
        }), {
            status,
            headers: { 'Content-Type': 'application/json; charset=UTF-8' }
        });
    });

    return app;
}
