import type { Context } from 'hono';
import type { AppEnvironment } from '@/app';
import {
    parseFudabaDelete,
    validFudabaCardId
} from '@/domains/fudaba/owner-card';
import { fudabaRepository, services } from '@/middleware/hono-context';
import { messageFromError, statusFromError } from '@/utils/http/error-response';
import { deleteObjectWithCompensation } from '@/utils/storage/delete-object';

export async function handleDeleteFudabaCard(
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
        const expectedRevision = parseFudabaDelete(body);
        const result = await fudabaRepository(c).softDeleteCardForOwner({
            cardId,
            ownerAccountId: c.get('platformUser')!.id,
            expectedRevision,
            deletedAt: new Date().toISOString()
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
        const cleanup = await Promise.allSettled([
            deleteObjectWithCompensation(services(c), result.card.front_object_key),
            deleteObjectWithCompensation(services(c), result.card.back_object_key)
        ]);
        for (const item of cleanup) {
            if (item.status === 'rejected') {
                console.error('Failed to schedule deleted Fudaba card media cleanup', item.reason);
            }
        }
        return c.json({ success: true, revision: result.card.revision });
    } catch (error) {
        const status = statusFromError(error);
        if (status >= 500) console.error('Failed to delete Fudaba card', error);
        return c.json({
            success: false,
            code: status >= 500 ? 'FUDABA_CARD_DELETE_FAILED' : 'FUDABA_CARD_INVALID',
            message: status >= 500 ? '名片删除失败' : messageFromError(error)
        }, status as 400 | 500);
    }
}
