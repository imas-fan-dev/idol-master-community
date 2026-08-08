import type { Context } from 'hono';
import type { AppEnvironment } from '@/app';
import { fudabaOwnerCardView, parseFudabaCardCreateFields } from '@/domains/fudaba/owner-card';
import { fudabaRepository, services } from '@/middleware/hono-context';
import type { UploadedFile } from '@/ports/http';
import type { FudabaCardMutationResult, FudabaCardRecord } from '@/ports/repositories';
import { randomHex } from '@/utils/crypto/random';
import { messageFromError, statusFromError } from '@/utils/http/error-response';
import { convertUserImageToWebp } from '@/utils/media/user-image';
import {
    fudabaCardBackObjectKey,
    fudabaCardFrontObjectKey
} from '@/utils/storage/business-object-keys';
import { deleteOwnedObjectWithCompensation } from '@/utils/storage/delete-object';

const MAX_CARD_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_CARD_REQUEST_BYTES = (MAX_CARD_IMAGE_BYTES * 2) + (128 * 1024);

function oneFile(value: UploadedFile | UploadedFile[] | undefined): UploadedFile | null {
    return value && !Array.isArray(value) ? value : null;
}

export async function handleCreateFudabaCard(
    c: Context<AppEnvironment>
): Promise<Response> {
    const runtime = services(c);
    if (!runtime.uploads || !runtime.images || !runtime.storage) {
        throw new Error('Upload services unavailable');
    }
    const created: Array<{ key: string; ownerToken: string }> = [];
    let cleanupCreatedObjects = true;
    try {
        const upload = await runtime.uploads.parse(c.req.raw, {
            maxBytes: MAX_CARD_REQUEST_BYTES,
            fileFields: ['front', 'back'],
            maxFiles: 2,
            maxFields: 8,
            maxParts: 10
        });
        const front = oneFile(upload.files.front);
        const back = oneFile(upload.files.back);
        if (!front || !back) {
            throw Object.assign(new Error('必须分别上传名片正面和背面'), { status: 400 });
        }
        const fields = parseFudabaCardCreateFields(upload.fields);
        const [frontImage, backImage] = await Promise.all([
            convertUserImageToWebp(front, runtime.images, MAX_CARD_IMAGE_BYTES),
            convertUserImageToWebp(back, runtime.images, MAX_CARD_IMAGE_BYTES)
        ]);
        const cardId = crypto.randomUUID();
        const frontKey = fudabaCardFrontObjectKey(cardId, 'webp');
        const backKey = fudabaCardBackObjectKey(cardId, 'webp');
        for (const image of [
            { key: frontKey, body: frontImage.body, side: 'front' },
            { key: backKey, body: backImage.body, side: 'back' }
        ]) {
            const ownerToken = randomHex(32);
            await runtime.storage.put(image.key, image.body, {
                contentType: 'image/webp',
                protectedAccess: true,
                ownerToken,
                metadata: {
                    kind: 'fudaba-card-image',
                    side: image.side,
                    account: c.get('platformUser')!.id
                }
            });
            created.push({ key: image.key, ownerToken });
        }
        const now = new Date().toISOString();
        const ownerAccountId = c.get('platformUser')!.id;
        const repository = fudabaRepository(c);
        cleanupCreatedObjects = false;
        let result: FudabaCardMutationResult;
        try {
            result = await repository.createCardForOwner({
                id: cardId,
                ownerAccountId,
                ...fields,
                frontObjectKey: frontKey,
                backObjectKey: backKey,
                createdAt: now,
                updatedAt: now
            });
        } catch (error) {
            let recovered: FudabaCardRecord | null | undefined;
            try {
                recovered = await repository.findCardForOwner(cardId, ownerAccountId);
            } catch (recoveryError) {
                console.error(
                    'Unable to reconcile an uncertain Fudaba card creation',
                    recoveryError
                );
            }
            if (
                recovered?.front_object_key === frontKey &&
                recovered.back_object_key === backKey
            ) {
                return c.json({
                    success: true,
                    card: fudabaOwnerCardView(recovered)
                }, 201);
            }
            throw error;
        }
        if (result.status !== 'saved') {
            cleanupCreatedObjects = true;
            await Promise.all(created.map(({ key, ownerToken }) =>
                deleteOwnedObjectWithCompensation(runtime, key, ownerToken)
            ));
            return c.json({ success: false, code: 'FUDABA_CARD_UNAVAILABLE' }, 409);
        }
        cleanupCreatedObjects = false;
        return c.json({ success: true, card: fudabaOwnerCardView(result.card) }, 201);
    } catch (error) {
        if (cleanupCreatedObjects) {
            await Promise.all(created.map(({ key, ownerToken }) =>
                deleteOwnedObjectWithCompensation(runtime, key, ownerToken)
                    .catch(() => undefined)
            ));
        }
        const status = statusFromError(error);
        if (status >= 500) console.error('Failed to create Fudaba card', error);
        return c.json({
            success: false,
            code: status >= 500 ? 'FUDABA_CARD_CREATE_FAILED' : 'FUDABA_CARD_INVALID',
            message: status >= 500 ? '名片创建失败' : messageFromError(error)
        }, status as 400 | 413 | 500);
    }
}
