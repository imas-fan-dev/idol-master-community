import type { Context } from 'hono';
import type { AppEnvironment } from '@/app';
import {
    encodeFudabaCardCursor,
    fudabaPublicCardView,
    parseFudabaCardQuery
} from '@/domains/fudaba/public-read';
import { fudabaRepository, services } from '@/middleware/hono-context';

export async function handleListFudabaPublicCards(
    c: Context<AppEnvironment>
): Promise<Response> {
    const query = parseFudabaCardQuery(c.req.url);
    const rows = await fudabaRepository(c).listPublicCards({
        ...query.filters,
        viewerAccountId: c.get('platformUser')?.id ?? null,
        limit: query.limit + 1,
        ...(query.after ? { after: query.after } : {})
    });
    const hasNextPage = rows.length > query.limit;
    const page = hasNextPage ? rows.slice(0, query.limit) : rows;
    const items = await Promise.all(page.map((card) =>
        fudabaPublicCardView(services(c).storage, card)
    ));
    const last = page.at(-1);
    return c.json({
        items,
        pageInfo: {
            hasNextPage,
            nextCursor: hasNextPage && last
                ? encodeFudabaCardCursor(query.filters, {
                    createdAt: last.created_at,
                    id: last.id
                })
                : null
        }
    });
}
