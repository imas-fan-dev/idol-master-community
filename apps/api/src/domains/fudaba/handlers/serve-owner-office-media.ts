import type { Context } from 'hono';
import type { AppEnvironment } from '@/app';
import { validFudabaOfficeId } from '@/domains/fudaba/office-management';
import { fudabaRepository, services } from '@/middleware/hono-context';
import { objectReadResponse } from '@/utils/http/object-read-response';

async function serveOfficeMedia(
    c: Context<AppEnvironment>,
    pending: boolean
): Promise<Response> {
    const officeId = c.req.param('officeId') || '';
    if (!validFudabaOfficeId(officeId)) return c.text('Not Found', 404);
    const office = await fudabaRepository(c).findOfficeForOwner(
        officeId,
        c.get('platformUser')!.id
    );
    if (!office) return c.text('Not Found', 404);
    const key = pending
        ? office.pending_cover_object_key
        : office.cover_object_key;
    if (!key) return c.text('Not Found', 404);
    const storage = services(c).storage;
    if (!storage) throw new Error('Object storage unavailable');
    const response = await objectReadResponse(c.req.raw, storage, key, {
        'Cache-Control': 'private, no-store',
        'Vary': 'Authorization, Cookie'
    });
    return response ?? c.text('Not Found', 404);
}

export function handleServeFudabaOwnerOfficeCover(
    c: Context<AppEnvironment>
): Promise<Response> {
    return serveOfficeMedia(c, false);
}

export function handleServeFudabaOwnerOfficePendingCover(
    c: Context<AppEnvironment>
): Promise<Response> {
    return serveOfficeMedia(c, true);
}
