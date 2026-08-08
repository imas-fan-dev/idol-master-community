import type { Context } from 'hono';
import type { AppEnvironment } from '@/app';
import {
    fudabaOfficeConflict,
    fudabaOwnerOfficeView,
    validFudabaOfficeId
} from '@/domains/fudaba/office-management';
import { parseFudabaRevision } from '@/domains/fudaba/owner-card';
import { fudabaRepository, services } from '@/middleware/hono-context';
import type { UploadedFile } from '@/ports/http';
import type {
    FudabaOfficeMutationResult,
    FudabaOwnerOfficeRecord
} from '@/ports/repositories';
import { randomHex } from '@/utils/crypto/random';
import { messageFromError, statusFromError } from '@/utils/http/error-response';
import { convertUserImageToWebp } from '@/utils/media/user-image';
import { fudabaOfficeCoverVersionObjectKey } from '@/utils/storage/business-object-keys';
import { deleteOwnedObjectWithCompensation } from '@/utils/storage/delete-object';

const MAX_OFFICE_COVER_BYTES = 8 * 1024 * 1024;

function oneFile(value: UploadedFile | UploadedFile[] | undefined): UploadedFile | null {
    return value && !Array.isArray(value) ? value : null;
}

function exactFields(fields: Record<string, string>): void {
    if (
        Object.keys(fields).length !== 1 ||
        !Object.prototype.hasOwnProperty.call(fields, 'expectedRevision')
    ) {
        throw Object.assign(new Error('上传字段无效'), { status: 400 });
    }
}

async function reconcileReservation(
    c: Context<AppEnvironment>,
    officeId: string,
    ownerAccountId: string,
    objectKey: string,
    expectedRevision: number,
    originalError: unknown
): Promise<FudabaOfficeMutationResult> {
    try {
        const current = await fudabaRepository(c).findOfficeForOwner(
            officeId,
            ownerAccountId
        );
        if (
            current?.pending_cover_object_key === objectKey &&
            current.revision >= expectedRevision + 1
        ) {
            return {
                status: 'saved',
                office: current,
                previousPendingObjectKey: null
            };
        }
    } catch (recoveryError) {
        console.error(
            'Unable to reconcile an uncertain Fudaba cover reservation',
            recoveryError
        );
    }
    throw originalError;
}

async function releaseReservation(
    c: Context<AppEnvironment>,
    officeId: string,
    ownerAccountId: string,
    objectKey: string,
    initialRevision: number
): Promise<'released' | 'referenced' | 'unknown'> {
    let expectedRevision = initialRevision;
    let lastError: unknown = null;
    let confirmedReference = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        let result: FudabaOfficeMutationResult | null = null;
        try {
            result = await fudabaRepository(c).clearPendingOfficeCoverForOwner({
                officeId,
                ownerAccountId,
                objectKey,
                expectedRevision,
                updatedAt: new Date().toISOString()
            });
        } catch (error) {
            lastError = error;
        }
        if (result?.status === 'saved') return 'released';

        let current: FudabaOwnerOfficeRecord | null;
        try {
            current = await fudabaRepository(c).findOfficeForOwner(
                officeId,
                ownerAccountId
            );
        } catch (error) {
            lastError = error;
            continue;
        }
        if (!current) return 'released';
        if (current.cover_object_key === objectKey) return 'referenced';
        if (current.pending_cover_object_key !== objectKey) return 'released';
        confirmedReference = true;
        expectedRevision = current.revision;
    }
    if (lastError) {
        console.error('Unable to confirm Fudaba cover reservation release', lastError);
    }
    return confirmedReference ? 'referenced' : 'unknown';
}

async function confirmStoredCoverReference(
    c: Context<AppEnvironment>,
    officeId: string,
    ownerAccountId: string,
    objectKey: string
): Promise<{
    state: 'referenced';
    office: FudabaOwnerOfficeRecord;
} | {
    state: 'released';
    office: FudabaOwnerOfficeRecord | null;
} | {
    state: 'unknown';
}> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            const current = await fudabaRepository(c).findOfficeForOwner(
                officeId,
                ownerAccountId
            );
            if (
                current?.pending_cover_object_key === objectKey ||
                current?.cover_object_key === objectKey
            ) {
                return { state: 'referenced', office: current };
            }
            return { state: 'released', office: current };
        } catch (error) {
            lastError = error;
        }
    }
    if (lastError) {
        console.error('Unable to confirm a stored Fudaba cover reference', lastError);
    }
    return { state: 'unknown' };
}

function preflightResponse(
    c: Context<AppEnvironment>,
    office: FudabaOwnerOfficeRecord
): Response | null {
    if (office.status !== 'active') {
        return c.json(fudabaOfficeConflict(office.revision, office.status), 409);
    }
    if (office.pending_cover_object_key) {
        return c.json({
            success: false,
            code: 'FUDABA_OFFICE_COVER_PENDING',
            revision: office.revision
        }, 409);
    }
    return null;
}

export async function handleUploadFudabaOfficeCover(
    c: Context<AppEnvironment>
): Promise<Response> {
    const officeId = c.req.param('officeId') || '';
    if (!validFudabaOfficeId(officeId)) {
        return c.json({ success: false, code: 'FUDABA_OFFICE_NOT_FOUND' }, 404);
    }
    const ownerAccountId = c.get('platformUser')!.id;
    const repository = fudabaRepository(c);
    const current = await repository.findOfficeForOwner(officeId, ownerAccountId);
    if (!current) {
        return c.json({ success: false, code: 'FUDABA_OFFICE_NOT_FOUND' }, 404);
    }
    const rejected = preflightResponse(c, current);
    if (rejected) return rejected;

    const runtime = services(c);
    if (!runtime.uploads || !runtime.images || !runtime.storage) {
        throw new Error('Upload services unavailable');
    }
    let objectKey = '';
    let ownerToken = '';
    try {
        const upload = await runtime.uploads.parse(c.req.raw, {
            maxBytes: MAX_OFFICE_COVER_BYTES + (64 * 1024),
            fileFields: ['image'],
            maxFiles: 1,
            maxFields: 1,
            maxParts: 2
        });
        exactFields(upload.fields);
        const expectedRevision = parseFudabaRevision(upload.fields.expectedRevision);
        if (current.revision !== expectedRevision) {
            return c.json({
                success: false,
                code: 'FUDABA_OFFICE_CONFLICT',
                revision: current.revision
            }, 409);
        }
        const file = oneFile(upload.files.image);
        if (!file) {
            throw Object.assign(new Error('必须上传一张图片'), { status: 400 });
        }
        const converted = await convertUserImageToWebp(
            file,
            runtime.images,
            MAX_OFFICE_COVER_BYTES
        );
        objectKey = fudabaOfficeCoverVersionObjectKey(
            officeId,
            crypto.randomUUID()
        );
        ownerToken = randomHex(32);
        const submittedAt = new Date().toISOString();
        let reservation: FudabaOfficeMutationResult;
        try {
            reservation = await repository.reservePendingOfficeCoverForOwner({
                officeId,
                ownerAccountId,
                objectKey,
                expectedRevision,
                submittedAt
            });
        } catch (error) {
            reservation = await reconcileReservation(
                c,
                officeId,
                ownerAccountId,
                objectKey,
                expectedRevision,
                error
            );
        }
        if (reservation.status === 'unavailable') {
            return c.json({ success: false, code: 'FUDABA_OFFICE_NOT_FOUND' }, 404);
        }
        if (reservation.status === 'conflict') {
            return c.json({
                success: false,
                code: 'FUDABA_OFFICE_CONFLICT',
                revision: reservation.revision
            }, 409);
        }
        if (reservation.status === 'pending-exists') {
            return c.json({
                success: false,
                code: 'FUDABA_OFFICE_COVER_PENDING',
                revision: reservation.revision
            }, 409);
        }
        if (reservation.status === 'state-conflict') {
            return c.json(fudabaOfficeConflict(
                reservation.revision,
                reservation.officeStatus
            ), 409);
        }
        try {
            await runtime.storage.put(objectKey, converted.body, {
                contentType: 'image/webp',
                protectedAccess: true,
                ownerToken,
                metadata: {
                    kind: 'fudaba-office-cover',
                    office: officeId,
                    account: ownerAccountId
                }
            });
        } catch (error) {
            const releaseState = await releaseReservation(
                c,
                officeId,
                ownerAccountId,
                objectKey,
                reservation.office.revision
            );
            if (releaseState === 'released') {
                await deleteOwnedObjectWithCompensation(runtime, objectKey, ownerToken)
                    .catch((cleanupError) => {
                        console.error('Failed to clean up Fudaba cover upload', cleanupError);
                    });
            }
            objectKey = '';
            throw error;
        }
        const confirmation = await confirmStoredCoverReference(
            c,
            officeId,
            ownerAccountId,
            objectKey
        );
        if (confirmation.state === 'released') {
            await deleteOwnedObjectWithCompensation(runtime, objectKey, ownerToken);
            objectKey = '';
            return c.json({
                success: false,
                code: 'FUDABA_OFFICE_CONFLICT',
                revision: confirmation.office?.revision ?? reservation.office.revision
            }, 409);
        }
        if (confirmation.state === 'unknown') {
            objectKey = '';
            throw new Error('Unable to confirm stored Fudaba cover reference');
        }
        objectKey = '';
        return c.json({
            success: true,
            office: fudabaOwnerOfficeView(confirmation.office)
        }, 202);
    } catch (error) {
        if (objectKey) {
            await deleteOwnedObjectWithCompensation(runtime, objectKey, ownerToken)
                .catch(() => undefined);
        }
        const status = statusFromError(error);
        if (status >= 500) console.error('Failed to upload Fudaba office cover', error);
        return c.json({
            success: false,
            code: status >= 500
                ? 'FUDABA_OFFICE_COVER_UPLOAD_FAILED'
                : 'FUDABA_OFFICE_COVER_INVALID',
            message: status >= 500 ? '交换所封面上传失败' : messageFromError(error)
        }, status as 400 | 413 | 500);
    }
}
