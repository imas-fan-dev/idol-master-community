import type { Context } from 'hono';
import type { AppEnvironment } from '@/app';
import {
    fudabaLocationReviewView,
    parseFudabaLocationReviewQuery
} from '@/domains/fudaba/office-location';
import { fudabaRepository } from '@/middleware/hono-context';

export async function handleListFudabaLocationReviews(
    c: Context<AppEnvironment>
): Promise<Response> {
    const query = parseFudabaLocationReviewQuery(c.req.url);
    const rows = await fudabaRepository(c).listOfficeLocationReviews(query);
    return c.json({ items: rows.map(fudabaLocationReviewView) });
}
