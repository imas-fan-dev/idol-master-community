import type { Context } from 'hono';
import type { AppEnvironment } from '@/app';
import {
    fudabaOfficeConflict,
    fudabaOwnerOfficeView,
    parseFudabaOfficeUpdate,
    validFudabaOfficeId
} from '@/domains/fudaba/office-management';
import { fudabaRepository } from '@/middleware/hono-context';
import { messageFromError, statusFromError } from '@/utils/http/error-response';

export async function handleUpdateFudabaOwnerOffice(
    c: Context<AppEnvironment>
): Promise<Response> {
    try {
        const officeId = c.req.param('officeId') || '';
        if (!validFudabaOfficeId(officeId)) {
            return c.json({ success: false, code: 'FUDABA_OFFICE_NOT_FOUND' }, 404);
        }
        const body = await c.req.json().catch(() => {
            throw Object.assign(new Error('请求体必须是有效 JSON'), { status: 400 });
        });
        const update = parseFudabaOfficeUpdate(body);
        const result = await fudabaRepository(c).updateOfficeForOwner({
            officeId,
            ownerAccountId: c.get('platformUser')!.id,
            ...update,
            updatedAt: new Date().toISOString()
        });
        if (result.status === 'unavailable') {
            return c.json({ success: false, code: 'FUDABA_OFFICE_NOT_FOUND' }, 404);
        }
        if (result.status === 'conflict' || result.status === 'pending-exists') {
            return c.json({
                success: false,
                code: 'FUDABA_OFFICE_CONFLICT',
                revision: result.revision
            }, 409);
        }
        if (result.status === 'state-conflict') {
            return c.json(fudabaOfficeConflict(
                result.revision,
                result.officeStatus
            ), 409);
        }
        return c.json({
            success: true,
            office: fudabaOwnerOfficeView(result.office)
        });
    } catch (error) {
        const status = statusFromError(error);
        if (status >= 500) console.error('Failed to update Fudaba office', error);
        return c.json({
            success: false,
            code: status >= 500
                ? 'FUDABA_OFFICE_SAVE_FAILED'
                : 'FUDABA_OFFICE_INVALID',
            message: status >= 500 ? '交换所保存失败' : messageFromError(error)
        }, status as 400 | 500);
    }
}
