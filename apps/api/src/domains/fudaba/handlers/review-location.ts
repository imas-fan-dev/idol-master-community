import type { Context } from 'hono';
import type { AppEnvironment } from '@/app';
import {
    fudabaOwnerLocationView,
    parseFudabaLocationReview,
    validFudabaOfficeId
} from '@/domains/fudaba/office-location';
import { fudabaRepository, getClientAddress } from '@/middleware/hono-context';
import { messageFromError, statusFromError } from '@/utils/http/error-response';

export async function handleReviewFudabaLocation(
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
        const submission = parseFudabaLocationReview(body);
        const actor = c.get('backofficeUser')!;
        const reviewedAt = new Date().toISOString();
        const action = submission.decision === 'publish'
            ? '发布 Fudaba 事务所公开位置'
            : '拒绝 Fudaba 事务所公开位置';
        const result = await fudabaRepository(c).reviewOfficePublicLocation({
            officeId,
            ...submission,
            reviewedAt,
            reviewedBy: actor.id,
            reviewOperationId: crypto.randomUUID(),
            audit: {
                username: actor.username,
                producername: actor.producername,
                action,
                target: `${officeId}@${submission.expectedRevision + 1}`,
                ip: getClientAddress(c),
                time: reviewedAt
            }
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
        return c.json({
            success: true,
            officeLocation: fudabaOwnerLocationView(result.location)
        });
    } catch (error) {
        const status = statusFromError(error);
        if (status >= 500) console.error('Failed to review Fudaba location', error);
        return c.json({
            success: false,
            code: status >= 500
                ? 'FUDABA_OFFICE_LOCATION_REVIEW_FAILED'
                : 'FUDABA_OFFICE_LOCATION_INVALID',
            message: status >= 500 ? '公开位置审核失败' : messageFromError(error)
        }, status as 400 | 500);
    }
}
