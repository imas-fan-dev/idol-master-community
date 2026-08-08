import type { Context } from 'hono';
import type { AppEnvironment } from '@/app';
import {
    fudabaOwnerCardView,
    parseFudabaCardUpdate,
    validFudabaCardId
} from '@/domains/fudaba/owner-card';
import { fudabaRepository } from '@/middleware/hono-context';
import { messageFromError, statusFromError } from '@/utils/http/error-response';

export async function handleUpdateFudabaCard(
    c: Context<AppEnvironment>
): Promise<Response> {
    try {
        const cardId = c.req.param('cardId') || '';
        if (!validFudabaCardId(cardId)) {
            return c.json({ success: false, code: 'FUDABA_CARD_NOT_FOUND' }, 404);
        }
        const body = await c.req.json().catch(() => {
            throw Object.assign(new Error('请求体必须是有效 JSON'), { status: 400 });
        });
        const update = parseFudabaCardUpdate(body);
        const result = await fudabaRepository(c).updateCardMetadataForOwner({
            cardId,
            ownerAccountId: c.get('platformUser')!.id,
            ...update,
            updatedAt: new Date().toISOString()
        });
        if (result.status === 'unavailable') {
            return c.json({ success: false, code: 'FUDABA_CARD_NOT_FOUND' }, 404);
        }
        if (result.status === 'conflict') {
            return c.json({
                success: false,
                code: 'FUDABA_CARD_CONFLICT',
                revision: result.revision
            }, 409);
        }
        return c.json({ success: true, card: fudabaOwnerCardView(result.card) });
    } catch (error) {
        const status = statusFromError(error);
        if (status >= 500) console.error('Failed to update Fudaba card', error);
        return c.json({
            success: false,
            code: status >= 500 ? 'FUDABA_CARD_SAVE_FAILED' : 'FUDABA_CARD_INVALID',
            message: status >= 500 ? '名片保存失败' : messageFromError(error)
        }, status as 400 | 500);
    }
}
