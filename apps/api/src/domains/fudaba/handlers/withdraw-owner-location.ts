import type { Context } from 'hono';
import type { AppEnvironment } from '@/app';
import {
    parseFudabaLocationWithdrawal,
    validFudabaOfficeId
} from '@/domains/fudaba/office-location';
import { fudabaRepository } from '@/middleware/hono-context';
import { messageFromError, statusFromError } from '@/utils/http/error-response';

export async function handleWithdrawFudabaOwnerLocation(
    c: Context<AppEnvironment>
): Promise<Response> {
    try {
        const officeId = c.req.param('officeId') || '';
        if (!validFudabaOfficeId(officeId)) {
            return c.json({
                success: false,
                code: 'FUDABA_OFFICE_LOCATION_NOT_FOUND'
            }, 404);
        }
        const body = await c.req.json().catch(() => {
            throw Object.assign(new Error('请求体必须是有效 JSON'), { status: 400 });
        });
        const result = await fudabaRepository(c).withdrawOfficePublicLocationForOwner({
            officeId,
            ownerAccountId: c.get('platformUser')!.id,
            expectedRevision: parseFudabaLocationWithdrawal(body)
        });
        if (result.status === 'unavailable') {
            return c.json({
                success: false,
                code: 'FUDABA_OFFICE_LOCATION_NOT_FOUND'
            }, 404);
        }
        if (result.status === 'conflict') {
            return c.json({
                success: false,
                code: 'FUDABA_OFFICE_LOCATION_CONFLICT',
                revision: result.revision
            }, 409);
        }
        return c.json({ success: true });
    } catch (error) {
        const status = statusFromError(error);
        if (status >= 500) {
            console.error('Failed to withdraw Fudaba office location', error);
        }
        return c.json({
            success: false,
            code: status >= 500
                ? 'FUDABA_OFFICE_LOCATION_WITHDRAW_FAILED'
                : 'FUDABA_OFFICE_LOCATION_INVALID',
            message: status >= 500 ? '公开位置撤回失败' : messageFromError(error)
        }, status as 400 | 500);
    }
}
