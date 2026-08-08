import type { Context } from 'hono';
import type { AppEnvironment } from '@/app';
import {
    fudabaCardPlacementView,
    parseFudabaCardPlacement
} from '@/domains/fudaba/card-placement';
import { validFudabaOfficeId } from '@/domains/fudaba/office-location';
import { validFudabaCardId } from '@/domains/fudaba/owner-card';
import { fudabaRepository } from '@/middleware/hono-context';
import { messageFromError, statusFromError } from '@/utils/http/error-response';

export async function handleSaveFudabaCardPlacement(
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
        const submission = parseFudabaCardPlacement(body);
        const result = await fudabaRepository(c).saveCardPlacementForOwner({
            officeId,
            cardId,
            ownerAccountId: c.get('platformUser')!.id,
            ...submission,
            updatedAt: new Date().toISOString()
        });
        if (result.status === 'unavailable') {
            return c.json({
                success: false,
                code: 'FUDABA_CARD_PLACEMENT_NOT_FOUND'
            }, 404);
        }
        if (result.status === 'conflict') {
            return c.json({
                success: false,
                code: 'FUDABA_CARD_PLACEMENT_CONFLICT',
                revision: result.revision
            }, 409);
        }
        return c.json({
            success: true,
            placement: fudabaCardPlacementView(result.placement)
        }, result.created ? 201 : 200);
    } catch (error) {
        const status = statusFromError(error);
        if (status >= 500) console.error('Failed to save Fudaba card placement', error);
        return c.json({
            success: false,
            code: status >= 500
                ? 'FUDABA_CARD_PLACEMENT_SAVE_FAILED'
                : 'FUDABA_CARD_PLACEMENT_INVALID',
            message: status >= 500 ? '名片位置保存失败' : messageFromError(error)
        }, status as 400 | 500);
    }
}
