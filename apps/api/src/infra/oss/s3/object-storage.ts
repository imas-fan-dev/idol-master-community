import crypto from 'node:crypto';
import {
    CopyObjectCommand,
    DeleteObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    PutObjectCommand,
    type S3Client
} from '@aws-sdk/client-s3';
import type {
    CompensationService,
    ObjectReadTarget,
    ObjectReadUrlOptions,
    ObjectStorage,
    PutObjectOptions,
    StoredObject
} from '@/ports/object-storage';
import {
    S3UploadStateMachine,
    type S3ObjectVersion,
    type S3StorageScope
} from '@/infra/oss/s3/upload-state-machine';
import { contentTypeForPath } from '@/utils/http/content-type';
import { PROTECTED_PHYSICAL_KEY_SEGMENT } from '@/utils/storage/object-access-policy';

export interface S3ObjectStorageOptions {
    bucket: string;
    publicReadUrlBase?: string;
    prefix?: string;
    readUrlTtlSeconds: number;
}

export type S3ReadUrlSigner = (
    command: GetObjectCommand | HeadObjectCommand,
    expiresInSeconds: number
) => Promise<string>;

interface ResolvedObject {
    physicalKey: string;
    storageScope: S3StorageScope;
    version: S3ObjectVersion;
}

function normalizeKey(key: string, preserveTrailingSlash = false): string {
    const normalized = key.replace(/^\/+/, '').replace(/\\/g, '/');
    const trailingSlash = normalized.endsWith('/');
    const withoutTrailingSlash = normalized.replace(/\/+$/, '');
    const segments = withoutTrailingSlash.split('/');
    if (
        !withoutTrailingSlash ||
        segments.some((segment) => !segment || segment === '.' || segment === '..')
    ) {
        throw new Error('Invalid object key');
    }
    return preserveTrailingSlash && trailingSlash
        ? `${withoutTrailingSlash}/`
        : withoutTrailingSlash;
}

function normalizedPrefix(options: S3ObjectStorageOptions): string {
    return options.prefix?.replace(/^\/+|\/+$/g, '') || '';
}

function withPrefix(prefix: string, key: string): string {
    return prefix ? `${prefix}/${key}` : key;
}

export function s3PhysicalObjectKey(
    options: S3ObjectStorageOptions,
    logicalKey: string,
    objectId: string,
    storageScope: S3StorageScope = 'public'
): string {
    const segments = normalizeKey(logicalKey).split('/');
    const filename = segments.pop()!;
    const directory = segments.join('/') || '_root';
    const semanticKey = `${directory}/objects/${objectId}/${filename}`;
    return withPrefix(normalizedPrefix(options), storageScope === 'private'
        ? `${PROTECTED_PHYSICAL_KEY_SEGMENT}/${semanticKey}`
        : semanticKey);
}

function sha256(body: Uint8Array): string {
    return crypto.createHash('sha256').update(body).digest('hex');
}

function errorStatus(error: unknown): number | undefined {
    if (!error || typeof error !== 'object') return undefined;
    return (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
}

function errorName(error: unknown): string | undefined {
    return error && typeof error === 'object' && 'name' in error
        ? String((error as { name: unknown }).name)
        : undefined;
}

function isMissing(error: unknown): boolean {
    return errorStatus(error) === 404 || ['NoSuchKey', 'NotFound'].includes(errorName(error) || '');
}

function encodeMetadata(metadata: Record<string, string> | undefined): Record<string, string> {
    return Object.fromEntries(
        Object.entries(metadata || {})
            .filter(([key]) => key.toLowerCase() !== 'ownertoken')
            .map(([key, value]) => [key, encodeURIComponent(value)])
    );
}

function encodeCopySource(bucket: string, key: string): string {
    return [bucket, ...key.split('/')].map(encodeURIComponent).join('/');
}

function publicObjectUrl(base: string, physicalKey: string): string {
    const encodedKey = physicalKey.split('/').map(encodeURIComponent).join('/');
    return `${base.replace(/\/$/, '')}/${encodedKey}`;
}

export class S3ObjectStorage implements ObjectStorage {
    constructor(
        private readonly client: Pick<S3Client, 'send' | 'destroy'>,
        private readonly options: S3ObjectStorageOptions,
        private readonly signReadUrl: S3ReadUrlSigner,
        private readonly state: S3UploadStateMachine,
        private readonly compensation?: CompensationService
    ) {}

    private physicalObjectKey(
        logicalKey: string,
        objectId: string,
        storageScope: S3StorageScope
    ): string {
        return s3PhysicalObjectKey(this.options, logicalKey, objectId, storageScope);
    }

    private physicalKeyForVersion(version: S3ObjectVersion): string {
        if (!version.physicalKey) {
            throw new Error(`S3 object has no semantic physical key: ${version.objectId}`);
        }
        return version.physicalKey;
    }

    private targetScope(protectedAccess = false): S3StorageScope {
        return protectedAccess ? 'private' : 'public';
    }

    async deletePhysicalObject(
        objectId: string,
        knownPhysicalKey?: string | null,
        _knownStorageScope?: S3StorageScope
    ): Promise<void> {
        const stored = knownPhysicalKey
            ? { physicalKey: knownPhysicalKey }
            : await this.state.physicalObject(objectId);
        if (!stored) throw new Error(`S3 object has no semantic physical key: ${objectId}`);
        await this.client.send(new DeleteObjectCommand({
            Bucket: this.options.bucket,
            Key: stored.physicalKey
        }));
    }

    private storedObject(
        body: Uint8Array,
        contentType: string | undefined,
        etag: string | undefined,
        uploadedAt: Date | undefined
    ): StoredObject {
        return {
            body,
            size: body.byteLength,
            contentType: contentType || 'application/octet-stream',
            etag: etag || `"${sha256(body)}"`,
            uploadedAt
        };
    }

    private async resolve(key: string): Promise<ResolvedObject | null> {
        const logicalKey = normalizeKey(key);
        const readable = await this.state.readable(logicalKey);
        return readable
            ? {
                physicalKey: this.physicalKeyForVersion(readable),
                storageScope: readable.storageScope,
                version: readable
            }
            : null;
    }

    private async getResolved(resolved: ResolvedObject): Promise<StoredObject | null> {
        try {
            const result = await this.client.send(new GetObjectCommand({
                Bucket: this.options.bucket,
                Key: resolved.physicalKey
            }));
            if (!result.Body) throw new Error('S3 returned an object without a body');
            const body = await result.Body.transformToByteArray();
            return this.storedObject(body, result.ContentType, result.ETag, result.LastModified);
        } catch (error) {
            if (isMissing(error)) return null;
            throw error;
        }
    }

    async get(key: string): Promise<StoredObject | null> {
        const resolved = await this.resolve(key);
        return resolved ? this.getResolved(resolved) : null;
    }

    async createPublicReadUrl(key: string): Promise<string | null> {
        const resolved = await this.resolve(key);
        if (
            !resolved ||
            resolved.storageScope !== 'public' ||
            !this.options.publicReadUrlBase
        ) {
            return null;
        }
        return publicObjectUrl(this.options.publicReadUrlBase, resolved.physicalKey);
    }

    async createReadUrl(
        key: string,
        options: ObjectReadUrlOptions = {}
    ): Promise<ObjectReadTarget | null> {
        const resolved = await this.resolve(key);
        if (!resolved || !await this.physicalExists(resolved)) return null;
        if (resolved.storageScope === 'public' && this.options.publicReadUrlBase) {
            return {
                url: publicObjectUrl(this.options.publicReadUrlBase, resolved.physicalKey),
                visibility: 'public'
            };
        }
        const input = {
            Bucket: this.options.bucket,
            Key: resolved.physicalKey
        };
        const command = options.method === 'HEAD'
            ? new HeadObjectCommand(input)
            : new GetObjectCommand(input);
        return {
            url: await this.signReadUrl(command, this.options.readUrlTtlSeconds),
            visibility: 'private'
        };
    }

    async put(key: string, body: Uint8Array, options: PutObjectOptions = {}): Promise<StoredObject> {
        const result = await this.putVersion(key, body, options);
        if (!result) throw new Error('Concurrent S3 object mutation');
        return result;
    }

    private async putVersion(
        key: string,
        body: Uint8Array,
        options: PutObjectOptions,
        expectedEtag?: string | null
    ): Promise<StoredObject | null> {
        const logicalKey = normalizeKey(key);
        const digest = sha256(body);
        if (options.sha256 && options.sha256.toLowerCase() !== digest) {
            throw new Error('SHA-256 mismatch');
        }
        let expectedPreviousObjectId: string | null | undefined;
        if (expectedEtag !== undefined) {
            const expectedMutationIdentity = await this.state.mutationIdentity(logicalKey);
            const current = await this.get(logicalKey);
            if ((expectedEtag === null && current) ||
                (expectedEtag !== null && current?.etag !== expectedEtag)) {
                return null;
            }
            expectedPreviousObjectId = expectedMutationIdentity;
        }

        const objectId = crypto.randomUUID();
        const storageScope = this.targetScope(
            options.deferredPublication || options.protectedAccess
        );
        const physicalKey = this.physicalObjectKey(logicalKey, objectId, storageScope);
        const operation = await this.state.beginUpload(
            logicalKey,
            objectId,
            physicalKey,
            storageScope,
            options.deferredPublication ? 'pending' : 'ready'
        );
        if (expectedPreviousObjectId !== undefined &&
            operation.previousObjectId !== expectedPreviousObjectId) {
            await this.state.abortUpload(operation.id);
            return null;
        }
        const contentType = options.contentType || contentTypeForPath(logicalKey);
        try {
            const result = await this.client.send(new PutObjectCommand({
                Bucket: this.options.bucket,
                Key: physicalKey,
                Body: body,
                ContentType: contentType,
                Metadata: {
                    ...encodeMetadata(options.metadata),
                    sha256: digest,
                    logicalKey: encodeURIComponent(logicalKey)
                }
            }));
            const etag = result.ETag || `"${digest}"`;
            const completed = await this.state.completeUpload(operation, {
                size: body.byteLength,
                contentType,
                sha256: digest,
                etag,
                ownerToken: options.ownerToken || null
            });
            if (!completed) {
                await this.cleanupPhysicalObject(objectId);
                return null;
            }
            if (operation.targetState === 'ready') {
                for (const supersededObjectId of await this.state.supersededObjectIds(operation)) {
                    await this.cleanupPhysicalObject(supersededObjectId, undefined, true);
                }
            }
            return this.storedObject(body, contentType, etag, new Date());
        } catch (error) {
            await this.state.abortUpload(operation.id).catch(() => undefined);
            await this.cleanupPhysicalObject(objectId, error);
            throw error;
        }
    }

    async putIfUnchanged(
        key: string,
        expectedEtag: string | null,
        body: Uint8Array,
        options: PutObjectOptions = {}
    ): Promise<StoredObject | null> {
        return this.putVersion(key, body, options, expectedEtag);
    }

    private async cleanupPhysicalObject(
        objectId: string,
        cause?: unknown,
        durableCleanup = false
    ): Promise<void> {
        if (await this.state.isObjectReferenced(objectId)) return;
        const physicalObject = await this.state.physicalObject(objectId);
        try {
            await this.deletePhysicalObject(
                objectId,
                physicalObject?.physicalKey,
                physicalObject?.storageScope
            );
            await this.state.removeVersionIfUnreferenced(objectId);
        } catch (error) {
            if (durableCleanup) return;
            if (!this.compensation) throw error;
            await this.compensation.enqueue(
                'delete-s3-object',
                {
                    objectId,
                    physicalKey: physicalObject?.physicalKey ?? null,
                    storageScope: physicalObject?.storageScope ?? 'private'
                },
                cause ?? error
            );
        }
    }

    async delete(key: string): Promise<void> {
        const logicalKey = normalizeKey(key);
        const objectId = await this.state.claimDelete(logicalKey);
        if (objectId) await this.cleanupPhysicalObject(objectId, undefined, true);
    }

    async deleteIfObjectId(key: string, expectedObjectId: string): Promise<boolean> {
        const logicalKey = normalizeKey(key);
        if (!await this.state.isManaged(logicalKey)) return false;
        const objectId = await this.state.claimDelete(logicalKey, { objectId: expectedObjectId });
        if (!objectId) return false;
        await this.cleanupPhysicalObject(objectId, undefined, true);
        return true;
    }

    async deleteIfOwned(key: string, expectedOwnerToken: string): Promise<boolean> {
        const logicalKey = normalizeKey(key);
        if (!await this.state.isManaged(logicalKey)) return false;
        const objectId = await this.state.claimDelete(logicalKey, {
            ownerToken: expectedOwnerToken
        });
        if (!objectId) return false;
        await this.cleanupPhysicalObject(objectId, undefined, true);
        return true;
    }

    private async physicalExists(
        object: Pick<ResolvedObject, 'physicalKey' | 'storageScope'>
    ): Promise<boolean> {
        try {
            await this.client.send(new HeadObjectCommand({
                Bucket: this.options.bucket,
                Key: object.physicalKey
            }));
            return true;
        } catch (error) {
            if (isMissing(error)) return false;
            throw error;
        }
    }

    async exists(key: string): Promise<boolean> {
        const resolved = await this.resolve(key);
        return resolved ? this.physicalExists(resolved) : false;
    }

    async copy(sourceKey: string, destinationKey: string): Promise<void> {
        const source = await this.resolve(sourceKey);
        if (!source) throw new Error('S3 source object not found');
        await this.copyVersion(source, destinationKey, source.version.ownerToken);
    }

    private async copyVersion(
        source: ResolvedObject,
        destinationKey: string,
        ownerToken: string | null
    ): Promise<void> {
        const logicalKey = normalizeKey(destinationKey);
        const storageScope = this.targetScope();
        const objectId = crypto.randomUUID();
        const physicalKey = this.physicalObjectKey(logicalKey, objectId, storageScope);
        const operation = await this.state.beginUpload(
            logicalKey,
            objectId,
            physicalKey,
            storageScope,
            'ready'
        );
        let copied = false;
        try {
            const result = await this.client.send(new CopyObjectCommand({
                Bucket: this.options.bucket,
                Key: physicalKey,
                CopySource: encodeCopySource(
                    this.options.bucket,
                    source.physicalKey
                ),
                MetadataDirective: 'COPY'
            }));
            copied = true;
            const completed = await this.state.completeUpload(operation, {
                size: source.version.size,
                contentType: source.version.contentType,
                sha256: source.version.sha256,
                etag: result.CopyObjectResult?.ETag || source.version.etag,
                ownerToken
            });
            if (!completed) throw new Error('Concurrent S3 object mutation');
            for (const supersededObjectId of await this.state.supersededObjectIds(operation)) {
                await this.cleanupPhysicalObject(supersededObjectId, undefined, true);
            }
        } catch (error) {
            await this.state.abortUpload(operation.id).catch(() => undefined);
            if (copied) await this.cleanupPhysicalObject(objectId, error);
            throw error;
        }
    }

    async move(sourceKey: string, destinationKey: string): Promise<void> {
        await this.copy(sourceKey, destinationKey);
        await this.delete(sourceKey);
    }

    async moveIfOwned(
        sourceKey: string,
        destinationKey: string,
        expectedOwnerToken: string
    ): Promise<boolean> {
        const source = await this.state.snapshot(normalizeKey(sourceKey));
        if (!source || source.ownerToken !== expectedOwnerToken ||
            !['pending', 'ready'].includes(source.state)) {
            return false;
        }
        const resolved = {
            physicalKey: this.physicalKeyForVersion(source),
            storageScope: source.storageScope,
            version: source
        };
        if (!await this.physicalExists(resolved)) return false;
        await this.copyVersion(resolved, destinationKey, expectedOwnerToken);
        const deleted = await this.deleteIfOwned(sourceKey, expectedOwnerToken);
        if (!deleted) {
            await this.deleteIfOwned(destinationKey, expectedOwnerToken);
            return false;
        }
        return true;
    }

    async list(prefix: string) {
        const logicalPrefix = prefix ? normalizeKey(prefix, true) : '';
        return (await this.state.listReadable(logicalPrefix)).map((object) => ({
            key: object.logicalKey,
            size: object.size,
            etag: object.etag
        }));
    }

    async deletePrefix(prefix: string): Promise<void> {
        for (const object of await this.list(prefix)) await this.delete(object.key);
    }

    async publish(key: string): Promise<void> {
        const logicalKey = normalizeKey(key);
        const snapshot = await this.state.snapshot(logicalKey);
        if (!snapshot) throw new Error('S3 object not found');
        const targetScope = this.targetScope();
        if (snapshot.storageScope !== targetScope) {
            const resolved = {
                physicalKey: this.physicalKeyForVersion(snapshot),
                storageScope: snapshot.storageScope,
                version: snapshot
            };
            if (!await this.physicalExists(resolved)) throw new Error('S3 object not found');
            await this.copyVersion(resolved, logicalKey, snapshot.ownerToken);
            return;
        }
        const supersededObjectIds = await this.state.publish(logicalKey);
        for (const objectId of supersededObjectIds) {
            await this.cleanupPhysicalObject(objectId, undefined, true);
        }
    }

    async reconcilePlacement(key: string): Promise<boolean> {
        const logicalKey = normalizeKey(key);
        const resolved = await this.resolve(logicalKey);
        if (!resolved || resolved.storageScope === this.targetScope()) return false;
        if (!await this.physicalExists(resolved)) throw new Error('S3 object not found');
        await this.copyVersion(resolved, logicalKey, resolved.version.ownerToken);
        return true;
    }

    async recoverStaleUploads(limit = 10, staleSeconds = 15 * 60): Promise<void> {
        if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid recovery limit');
        if (!Number.isInteger(staleSeconds) || staleSeconds < 1) {
            throw new Error('Invalid stale upload age');
        }
        const operations = await this.state.staleOperations(
            limit,
            Date.now() - (staleSeconds * 1000)
        );
        for (const operation of operations) {
            const objectId = await this.state.claimStale(operation);
            if (objectId) await this.cleanupPhysicalObject(objectId, undefined, true);
        }
    }

    close(): void {
        this.client.destroy();
    }
}
