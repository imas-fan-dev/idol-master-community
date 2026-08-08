import type { Context } from 'hono';
import type { AppEnvironment } from '@/app';
import {
    fudabaOfficeConflict,
    fudabaOwnerOfficeView,
    parseFudabaOfficeRevision,
    validFudabaOfficeId
} from '@/domains/fudaba/office-management';
import { fudabaRepository, services } from '@/middleware/hono-context';
import { messageFromError, statusFromError } from '@/utils/http/error-response';
import { deleteObjectWithCompensation } from '@/utils/storage/delete-object';

export async function handleWithdrawFudabaOfficeCover(
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
        const expectedRevision = parseFudabaOfficeRevision(body);
        const ownerAccountId = c.get('platformUser')!.id;
        const repository = fudabaRepository(c);
        const current = await repository.findOfficeForOwner(officeId, ownerAccountId);
        if (!current) {
            return c.json({ success: false, code: 'FUDABA_OFFICE_NOT_FOUND' }, 404);
        }
        const objectKey = current.pending_cover_object_key;
        if (!objectKey) {
            return c.json({
                success: false,
                code: 'FUDABA_OFFICE_PENDING_COVER_NOT_FOUND',
                revision: current.revision
            }, 409);
        }
        let result;
        try {
            result = await repository.clearPendingOfficeCoverForOwner({
                officeId,
                ownerAccountId,
                objectKey,
                expectedRevision,
                updatedAt: new Date().toISOString()
            });
        } catch (error) {
            let recovered;
            try {
                recovered = await repository.findOfficeForOwner(
                    officeId,
                    ownerAccountId
                );
            } catch (recoveryError) {
                console.error(
                    'Unable to reconcile an uncertain Fudaba cover withdrawal',
                    recoveryError
                );
            }
            if (
                recovered && recovered.pending_cover_object_key !== objectKey &&
                recovered.cover_object_key !== objectKey
            ) {
                await deleteObjectWithCompensation(services(c), objectKey);
                return c.json({
                    success: true,
                    office: fudabaOwnerOfficeView(recovered)
                });
            }
            if (recovered?.cover_object_key === objectKey) {
                return c.json({
                    success: false,
                    code: 'FUDABA_OFFICE_CONFLICT',
                    revision: recovered.revision
                }, 409);
            }
            throw error;
        }
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
        await deleteObjectWithCompensation(
            services(c),
            result.previousPendingObjectKey ?? objectKey
        );
        return c.json({
            success: true,
            office: fudabaOwnerOfficeView(result.office)
        });
    } catch (error) {
        const status = statusFromError(error);
        if (status >= 500) console.error('Failed to withdraw Fudaba office cover', error);
        return c.json({
            success: false,
            code: status >= 500
                ? 'FUDABA_OFFICE_COVER_WITHDRAW_FAILED'
                : 'FUDABA_OFFICE_COVER_INVALID',
            message: status >= 500 ? '交换所封面撤回失败' : messageFromError(error)
        }, status as 400 | 500);
    }
}
