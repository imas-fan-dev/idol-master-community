import type { Context } from 'hono';
import type { AppEnvironment } from '@/app';
import {
    assertNoFudabaQuery,
    fudabaPublicOfficeView,
    fudabaPublicPlacedCardView,
    validFudabaOfficeSlug
} from '@/domains/fudaba/public-read';
import { fudabaRepository, services } from '@/middleware/hono-context';

export async function handleGetFudabaPublicOffice(
    c: Context<AppEnvironment>
): Promise<Response> {
    assertNoFudabaQuery(c.req.url);
    const slug = c.req.param('officeSlug');
    if (!slug || !validFudabaOfficeSlug(slug)) {
        return c.json({ error: 'Invalid Fudaba office slug' }, 400);
    }
    const office = await fudabaRepository(c).findPublicOfficeBySlug(
        slug,
        c.get('platformUser')?.id ?? null
    );
    if (!office) return c.json({ error: 'Fudaba office not found' }, 404);
    const storage = services(c).storage;
    const [view, cards] = await Promise.all([
        fudabaPublicOfficeView(storage, office),
        Promise.all(office.cards.map((card) =>
            fudabaPublicPlacedCardView(storage, card)
        ))
    ]);
    return c.json({ office: { ...view, cards } });
}
