import type { Context } from 'hono';
import type { AppEnvironment } from '@/app';
import {
    fudabaOwnerCardView,
    validFudabaCardId
} from '@/domains/fudaba/owner-card';
import { fudabaRepository } from '@/middleware/hono-context';

export async function handleGetFudabaOwnerCard(
    c: Context<AppEnvironment>
): Promise<Response> {
    const cardId = c.req.param('cardId') || '';
    if (!validFudabaCardId(cardId)) {
        return c.json({ success: false, code: 'FUDABA_CARD_NOT_FOUND' }, 404);
    }
    const card = await fudabaRepository(c).findCardForOwner(
        cardId,
        c.get('platformUser')!.id
    );
    return card
        ? c.json({ card: fudabaOwnerCardView(card) })
        : c.json({ success: false, code: 'FUDABA_CARD_NOT_FOUND' }, 404);
}
