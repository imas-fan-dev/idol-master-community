import type { Context } from 'hono';
import type { AppEnvironment } from '@/app';
import {
    fudabaOwnerLocationView,
    validFudabaOfficeId
} from '@/domains/fudaba/office-location';
import { assertNoFudabaQuery } from '@/domains/fudaba/public-read';
import { fudabaRepository } from '@/middleware/hono-context';

export async function handleGetFudabaOwnerLocation(
    c: Context<AppEnvironment>
): Promise<Response> {
    assertNoFudabaQuery(c.req.url);
    const officeId = c.req.param('officeId') || '';
    if (!validFudabaOfficeId(officeId)) {
        return c.json({
            success: false,
            code: 'FUDABA_OFFICE_LOCATION_NOT_FOUND'
        }, 404);
    }
    const repository = fudabaRepository(c);
    const office = await repository.findOfficeById(officeId);
    if (!office || office.owner_account_id !== c.get('platformUser')!.id) {
        return c.json({
            success: false,
            code: 'FUDABA_OFFICE_LOCATION_NOT_FOUND'
        }, 404);
    }
    const location = await repository.findOfficePublicLocationForOwner(
        officeId,
        c.get('platformUser')!.id
    );
    return c.json({
        location: location ? fudabaOwnerLocationView(location) : null
    });
}
