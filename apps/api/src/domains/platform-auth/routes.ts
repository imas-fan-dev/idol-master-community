import type { ImsHonoApp } from '@/app';
import { platformAuth } from '@/middleware/hono-auth';
import { handlePlatformLogout } from '@/domains/platform-auth/handlers/logout';
import { handlePlatformLogin } from '@/domains/platform-auth/handlers/login';
import { handlePlatformRefresh } from '@/domains/platform-auth/handlers/refresh';
import { handlePlatformRegister } from '@/domains/platform-auth/handlers/register';
import {
    handlePlatformRegistrationVerification
} from '@/domains/platform-auth/handlers/send-registration-verification';
import { handlePlatformSession } from '@/domains/platform-auth/handlers/session';

export function registerPlatformAuthRoutes(app: ImsHonoApp): void {
    app.post(
        '/api/platform/auth/register/verification-code',
        handlePlatformRegistrationVerification
    );
    app.post('/api/platform/auth/register', handlePlatformRegister);
    app.post('/api/platform/auth/login', handlePlatformLogin);
    app.get('/api/platform/auth/session', platformAuth, handlePlatformSession);
    app.post('/api/platform/auth/refresh', handlePlatformRefresh);
    app.post('/api/platform/auth/logout', handlePlatformLogout);
}
