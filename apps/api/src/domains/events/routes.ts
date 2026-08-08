import type { ImsHonoApp } from '@/app';
import { handleCreateEvent } from '@/domains/events/handlers/create-event';
import { handleDeleteEvent } from '@/domains/events/handlers/delete-event';
import { handleGetEvent } from '@/domains/events/handlers/get-event';
import { handleListEvents } from '@/domains/events/handlers/list-events';
import { backofficeAuth, backofficeCsrf, opOnly } from '@/middleware/hono-auth';

export function registerEventRoutes(app: ImsHonoApp): void {
    app.post('/api/events', backofficeAuth, opOnly, backofficeCsrf, handleCreateEvent);
    app.get('/api/events', handleListEvents);
    app.get('/api/events/:id', handleGetEvent);
    app.delete('/api/events/:id', backofficeAuth, opOnly, backofficeCsrf, handleDeleteEvent);
}
