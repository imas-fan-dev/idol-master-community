import type { Context } from 'hono';
import type { AppEnvironment } from '@/app';
import { validFudabaCardId } from '@/domains/fudaba/owner-card';
import { fudabaRepository, services } from '@/middleware/hono-context';
import { objectReadResponse } from '@/utils/http/object-read-response';

export async function handleServeFudabaOwnerCardMedia(
    c: Context<AppEnvironment>
): Promise<Response> {
    const cardId = c.req.param('cardId') || '';
    const side = c.req.param('side') || '';
    if (!validFudabaCardId(cardId) || !['front', 'back'].includes(side)) {
        return c.text('Not Found', 404);
    }
    const card = await fudabaRepository(c).findCardForOwner(
        cardId,
        c.get('platformUser')!.id
    );
    if (!card) return c.text('Not Found', 404);
    const storage = services(c).storage;
    if (!storage) throw new Error('Object storage unavailable');
    const key = side === 'front' ? card.front_object_key : card.back_object_key;
    const response = await objectReadResponse(c.req.raw, storage, key, {
        'Cache-Control': 'private, no-store',
        'Vary': 'Authorization, Cookie'
    });
    return response ?? c.text('Not Found', 404);
}
