import type { Context } from 'hono';
import type { AppEnvironment } from '@/app';
import { parseFudabaCardPlacementRemoval } from '@/domains/fudaba/card-placement';
import { validFudabaOfficeId } from '@/domains/fudaba/office-location';
import { validFudabaCardId } from '@/domains/fudaba/owner-card';
import { fudabaRepository } from '@/middleware/hono-context';
import { messageFromError, statusFromError } from '@/utils/http/error-response';

export async function handleRemoveFudabaCardPlacement(
    c: Context<AppEnvironment>
): Promise<Response> {
    try {
        const officeId = c.req.param('officeId') || '';
        const cardId = c.req.param('cardId') || '';
        if (!validFudabaOfficeId(officeId) || !validFudabaCardId(cardId)) {
            return c.json({
                success: false,
                code: 'FUDABA_CARD_PLACEMENT_NOT_FOUND'
            }, 404);
        }
        const body = await c.req.json().catch(() => {
            throw Object.assign(new Error('请求体必须是有效 JSON'), { status: 400 });
        });
        const result = await fudabaRepository(c).removeCardPlacementForOwner({
            officeId,
            cardId,
            ownerAccountId: c.get('platformUser')!.id,
            expectedRevision: parseFudabaCardPlacementRemoval(body)
        });
        if (result.status === 'unavailable') {
            return c.json({
                success: false,
                code: 'FUDABA_CARD_PLACEMENT_NOT_FOUND'
            }, 404);
        }
        if (result.status === 'conflict' || result.status === 'in-use') {
            return c.json({
                success: false,
                code: result.status === 'in-use'
                    ? 'FUDABA_CARD_PLACEMENT_IN_USE'
                    : 'FUDABA_CARD_PLACEMENT_CONFLICT',
                revision: result.revision
            }, 409);
        }
        return c.json({ success: true, revision: result.revision });
    } catch (error) {
        const status = statusFromError(error);
        if (status >= 500) console.error('Failed to remove Fudaba card placement', error);
        return c.json({
            success: false,
            code: status >= 500
                ? 'FUDABA_CARD_PLACEMENT_DELETE_FAILED'
                : 'FUDABA_CARD_PLACEMENT_INVALID',
            message: status >= 500 ? '名片位置删除失败' : messageFromError(error)
        }, status as 400 | 500);
    }
}
