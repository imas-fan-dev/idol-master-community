import type { Context } from 'hono';
import type { AppEnvironment } from '@/app';
import { fudabaOwnerCardView } from '@/domains/fudaba/owner-card';
import { fudabaRepository } from '@/middleware/hono-context';

export async function handleListFudabaOwnerCards(
    c: Context<AppEnvironment>
): Promise<Response> {
    const cards = await fudabaRepository(c).listCardsForOwner(c.get('platformUser')!.id);
    return c.json({ items: cards.map(fudabaOwnerCardView) });
}
