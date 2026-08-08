import type { Context } from 'hono';
import type { AppEnvironment } from '@/app';
import { fudabaOwnerOfficeView } from '@/domains/fudaba/office-management';
import { fudabaRepository } from '@/middleware/hono-context';

export async function handleListFudabaOwnerOffices(
    c: Context<AppEnvironment>
): Promise<Response> {
    const offices = await fudabaRepository(c).listOfficesForOwner(
        c.get('platformUser')!.id
    );
    return c.json({ items: offices.map(fudabaOwnerOfficeView) });
}
