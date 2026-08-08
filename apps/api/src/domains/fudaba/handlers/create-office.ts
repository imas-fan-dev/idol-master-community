import type { Context } from 'hono';
import type { AppEnvironment } from '@/app';
import {
    fudabaOfficeSlug,
    fudabaMutationIdempotencyKey,
    fudabaOwnerOfficeView,
    parseFudabaOfficeCreate
} from '@/domains/fudaba/office-management';
import { fudabaRepository } from '@/middleware/hono-context';
import { messageFromError, statusFromError } from '@/utils/http/error-response';
import { sha256Hex } from '@/utils/crypto/sha256';

export async function handleCreateFudabaOffice(
    c: Context<AppEnvironment>
): Promise<Response> {
    try {
        const body = await c.req.json().catch(() => {
            throw Object.assign(new Error('请求体必须是有效 JSON'), { status: 400 });
        });
        const fields = parseFudabaOfficeCreate(body);
        const idempotencyKey = fudabaMutationIdempotencyKey(c.req.raw);
        const [idempotencyKeyHash, requestHash] = await Promise.all([
            sha256Hex(new TextEncoder().encode(idempotencyKey)),
            sha256Hex(new TextEncoder().encode(JSON.stringify(fields)))
        ]);
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        const result = await fudabaRepository(c).createOfficeForOwner({
            id,
            ownerAccountId: c.get('platformUser')!.id,
            slug: fudabaOfficeSlug(fields.name, id),
            ...fields,
            coverObjectKey: null,
            visitorCount: 0,
            status: 'active',
            revision: 0,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            idempotencyKeyHash,
            requestHash,
            receiptCreatedAt: Date.now()
        });
        if (result.status === 'idempotency-conflict') {
            return c.json({
                success: false,
                code: 'FUDABA_IDEMPOTENCY_CONFLICT'
            }, 409);
        }
        if (result.status !== 'saved') {
            return c.json({
                success: false,
                code: 'FUDABA_OFFICE_UNAVAILABLE'
            }, 409);
        }
        return c.json({
            success: true,
            office: fudabaOwnerOfficeView(result.office)
        }, 201);
    } catch (error) {
        const status = statusFromError(error);
        if (status >= 500) console.error('Failed to create Fudaba office', error);
        return c.json({
            success: false,
            code: status >= 500
                ? 'FUDABA_OFFICE_CREATE_FAILED'
                : 'FUDABA_OFFICE_INVALID',
            message: status >= 500 ? '交换所创建失败' : messageFromError(error)
        }, status as 400 | 500);
    }
}
