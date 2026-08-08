import type { Context } from 'hono';
import type { AppEnvironment } from '@/app';
import {
    encodeFudabaOfficeCursor,
    fudabaPublicOfficeView,
    parseFudabaOfficeQuery
} from '@/domains/fudaba/public-read';
import { fudabaRepository, services } from '@/middleware/hono-context';

export async function handleListFudabaPublicOffices(
    c: Context<AppEnvironment>
): Promise<Response> {
    const query = parseFudabaOfficeQuery(c.req.url);
    const rows = await fudabaRepository(c).listPublicOffices({
        ...query.filters,
        limit: query.limit + 1,
        ...(query.after ? { after: query.after } : {})
    });
    const hasNextPage = rows.length > query.limit;
    const page = hasNextPage ? rows.slice(0, query.limit) : rows;
    const items = await Promise.all(page.map((office) =>
        fudabaPublicOfficeView(services(c).storage, office)
    ));
    const last = page.at(-1);
    return c.json({
        items,
        pageInfo: {
            hasNextPage,
            nextCursor: hasNextPage && last
                ? encodeFudabaOfficeCursor(query.filters, {
                    visitorCount: last.visitor_count,
                    id: last.id
                })
                : null
        }
    });
}
