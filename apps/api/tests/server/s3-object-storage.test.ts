import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import {
    CopyObjectCommand,
    DeleteObjectCommand,
    DeleteObjectsCommand,
    GetObjectCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    PutObjectCommand,
    type S3Client
} from '@aws-sdk/client-s3';
import {
    S3ObjectStorage,
    s3PhysicalObjectKey,
    type S3ObjectStorageOptions,
    type S3ReadUrlSigner
} from '@/infra/oss/s3/object-storage';
import { S3CompensationService } from '@/infra/oss/s3/compensation-service';
import { S3UploadStateMachine } from '@/infra/oss/s3/upload-state-machine';
import { PostgresConnection } from '@/infra/db/postgresql/connection';
import { createPostgresTestDatabase } from './postgres-test-database';

interface FakeObject {
    body: Uint8Array;
    contentType?: string;
    etag: string;
    lastModified: Date;
    metadata?: Record<string, string>;
}

function s3Error(name: string, status: number): Error {
    return Object.assign(new Error(name), {
        name,
        $metadata: { httpStatusCode: status }
    });
}

class FakeS3Client {
    readonly objects = new Map<string, FakeObject>();
    readonly commands: unknown[] = [];
    destroyCalls = 0;
    deleteFailuresRemaining = 0;
    putFailuresAfterWriteRemaining = 0;
    private revision = 0;

    object(bucket: string, key: string): FakeObject | undefined {
        return this.objects.get(`${bucket}/${key}`);
    }

    hasObject(bucket: string, key: string): boolean {
        return this.objects.has(`${bucket}/${key}`);
    }

    setObject(bucket: string, key: string, object: FakeObject): void {
        this.objects.set(`${bucket}/${key}`, object);
    }

    async send(command: unknown): Promise<any> {
        this.commands.push(command);
        if (command instanceof PutObjectCommand) {
            const key = command.input.Key!;
            const storageKey = `${command.input.Bucket}/${key}`;
            const current = this.objects.get(storageKey);
            if (command.input.IfNoneMatch === '*' && current) {
                throw s3Error('PreconditionFailed', 412);
            }
            if (command.input.IfMatch && current?.etag !== command.input.IfMatch) {
                throw s3Error('PreconditionFailed', 412);
            }
            const body = Uint8Array.from(command.input.Body as Uint8Array);
            const etag = `"etag-${++this.revision}"`;
            this.objects.set(storageKey, {
                body,
                contentType: command.input.ContentType,
                etag,
                lastModified: new Date('2026-07-22T00:00:00Z'),
                metadata: command.input.Metadata
            });
            if (this.putFailuresAfterWriteRemaining > 0) {
                this.putFailuresAfterWriteRemaining -= 1;
                throw s3Error('RequestTimeout', 408);
            }
            return { ETag: etag };
        }
        if (command instanceof GetObjectCommand) {
            const object = this.object(command.input.Bucket!, command.input.Key!);
            if (!object) throw s3Error('NoSuchKey', 404);
            return {
                Body: { transformToByteArray: async () => Uint8Array.from(object.body) },
                ContentType: object.contentType,
                ETag: object.etag,
                LastModified: object.lastModified
            };
        }
        if (command instanceof HeadObjectCommand) {
            if (!this.hasObject(command.input.Bucket!, command.input.Key!)) {
                throw s3Error('NotFound', 404);
            }
            return {};
        }
        if (command instanceof DeleteObjectCommand) {
            if (this.deleteFailuresRemaining > 0) {
                this.deleteFailuresRemaining -= 1;
                throw s3Error('ServiceUnavailable', 503);
            }
            this.objects.delete(`${command.input.Bucket}/${command.input.Key}`);
            return {};
        }
        if (command instanceof CopyObjectCommand) {
            const decoded = decodeURIComponent(command.input.CopySource!);
            const separator = decoded.indexOf('/');
            const sourceBucket = decoded.slice(0, separator);
            const sourceKey = decoded.slice(separator + 1);
            const source = this.object(sourceBucket, sourceKey);
            if (!source) throw s3Error('NoSuchKey', 404);
            this.setObject(command.input.Bucket!, command.input.Key!, {
                ...source,
                body: Uint8Array.from(source.body),
                lastModified: new Date('2026-07-22T00:00:01Z')
            });
            return {};
        }
        if (command instanceof ListObjectsV2Command) {
            const bucketPrefix = `${command.input.Bucket}/`;
            const keys = [...this.objects.keys()]
                .filter((key) => key.startsWith(bucketPrefix))
                .map((key) => key.slice(bucketPrefix.length))
                .filter((key) => key.startsWith(command.input.Prefix || ''))
                .sort();
            const start = Number(command.input.ContinuationToken || 0);
            const page = keys.slice(start, start + 2);
            const next = start + page.length;
            return {
                Contents: page.map((key) => ({
                    Key: key,
                    Size: this.object(command.input.Bucket!, key)!.body.byteLength,
                    ETag: this.object(command.input.Bucket!, key)!.etag
                })),
                IsTruncated: next < keys.length,
                NextContinuationToken: next < keys.length ? String(next) : undefined
            };
        }
        if (command instanceof DeleteObjectsCommand) {
            for (const object of command.input.Delete?.Objects || []) {
                if (object.Key) {
                    this.objects.delete(`${command.input.Bucket}/${object.Key}`);
                }
            }
            return {};
        }
        throw new Error(`Unexpected command: ${String(command)}`);
    }

    destroy(): void {
        this.destroyCalls += 1;
    }
}

async function fixture(
    t: TestContext,
    storageOptions: Partial<S3ObjectStorageOptions> = {}
): Promise<{
    client: FakeS3Client;
    connection: PostgresConnection;
    compensation: S3CompensationService;
    signed: Array<{ command: GetObjectCommand | HeadObjectCommand; expiresIn: number }>;
    state: S3UploadStateMachine;
    storage: S3ObjectStorage;
}> {
    const connection = await createPostgresTestDatabase(t, 's3-storage');
    const state = new S3UploadStateMachine(connection);
    await state.initialize();
    const client = new FakeS3Client();
    const signed: Array<{
        command: GetObjectCommand | HeadObjectCommand;
        expiresIn: number;
    }> = [];
    const signer: S3ReadUrlSigner = async (command, expiresIn) => {
        signed.push({ command, expiresIn });
        return `https://media.example.test/${encodeURIComponent(command.input.Key!)}`;
    };
    let storage: S3ObjectStorage;
    const compensation = new S3CompensationService(
        connection,
        state,
        (objectId, physicalKey, storageScope) =>
            storage.deletePhysicalObject(objectId, physicalKey, storageScope)
    );
    storage = new S3ObjectStorage(
        client as unknown as Pick<S3Client, 'send' | 'destroy'>,
        {
            bucket: 'ims-media-prod',
            prefix: 'ims/production',
            readUrlTtlSeconds: 300,
            ...storageOptions
        },
        signer,
        state,
        compensation
    );
    t.after(async () => {
        storage.close();
        await connection.close();
    });
    return { client, connection, compensation, signed, state, storage };
}

test('S3 object storage preserves logical keys across versioned CRUD, copy, and move', async (t) => {
    const { client, state, storage } = await fixture(t);
    const firstBody = new TextEncoder().encode('first');
    const first = await storage.put('uploads/news/original/a b.webp', firstBody, {
        contentType: 'image/webp',
        metadata: { owner: 'news', idol: '樱木真乃' }
    });
    assert.equal(first.size, firstBody.byteLength);
    const firstSnapshot = await state.snapshot('uploads/news/original/a b.webp');
    assert.ok(firstSnapshot);
    const firstPhysicalKey =
        `ims/production/uploads/news/original/objects/` +
        `${firstSnapshot.objectId}/a b.webp`;
    assert.equal(firstSnapshot.physicalKey, firstPhysicalKey);
    assert.equal(client.hasObject('ims-media-prod', firstPhysicalKey), true);
    assert.equal(
        client.object('ims-media-prod', firstPhysicalKey)?.metadata?.owner,
        'news'
    );
    assert.equal(
        client.object('ims-media-prod', firstPhysicalKey)?.metadata?.idol,
        encodeURIComponent('樱木真乃')
    );
    assert.match(
        client.object('ims-media-prod', firstPhysicalKey)?.metadata?.sha256 || '',
        /^[a-f0-9]{64}$/
    );

    assert.deepEqual((await storage.get('uploads/news/original/a b.webp'))?.body, firstBody);
    assert.equal(await storage.exists('uploads/news/original/a b.webp'), true);
    assert.equal(await storage.get('uploads/news/original/missing.webp'), null);
    assert.equal(await storage.exists('uploads/news/original/missing.webp'), false);

    assert.equal(await storage.putIfUnchanged(
        'uploads/news/original/a b.webp', null, new Uint8Array([9])
    ), null);
    const changed = await storage.putIfUnchanged(
        'uploads/news/original/a b.webp', first.etag, new Uint8Array([2, 3])
    );
    assert.ok(changed);

    await storage.copy(
        'uploads/news/original/a b.webp',
        'uploads/news/original/copy.webp'
    );
    await storage.move(
        'uploads/news/original/copy.webp',
        'uploads/news/original/moved.webp'
    );
    await storage.put('uploads/news/original/z.webp', new Uint8Array([4]));
    assert.equal(await storage.exists('uploads/news/original/copy.webp'), false);
    assert.equal(await storage.exists('uploads/news/original/moved.webp'), true);

    assert.deepEqual(
        (await storage.list('uploads/news/original/')).map((object) => object.key),
        [
            'uploads/news/original/a b.webp',
            'uploads/news/original/moved.webp',
            'uploads/news/original/z.webp'
        ]
    );
    assert.deepEqual(
        (await storage.list('')).map((object) => object.key),
        [
            'uploads/news/original/a b.webp',
            'uploads/news/original/moved.webp',
            'uploads/news/original/z.webp'
        ]
    );
    assert.equal(
        client.commands.some((command) => command instanceof ListObjectsV2Command),
        false,
        'logical listings come from the managed state index'
    );

    await storage.deletePrefix('uploads/news/original/');
    assert.deepEqual(await storage.list('uploads/news/original/'), []);
    assert.ok(await storage.putIfUnchanged(
        'uploads/news/original/a b.webp',
        null,
        new Uint8Array([7])
    ));
});

test('S3 object storage validates checksums and rejects unsafe logical keys', async (t) => {
    const { client, storage } = await fixture(t);
    await assert.rejects(
        storage.put('uploads/news/original/a.webp', new Uint8Array([1]), {
            sha256: '0'.repeat(64)
        }),
        /SHA-256 mismatch/
    );
    assert.equal(client.commands.length, 0);
    await assert.rejects(storage.get('../secret'), /Invalid object key/);
    await assert.rejects(storage.list('uploads//news/'), /Invalid object key/);
});

test('S3 object storage removes a write when PutObject times out after persistence', async (t) => {
    const { client, compensation, connection, state, storage } = await fixture(t);
    const key = 'uploads/news/original/timed-out.webp';
    client.putFailuresAfterWriteRemaining = 1;
    client.deleteFailuresRemaining = 1;

    await assert.rejects(
        storage.put(key, new Uint8Array([1, 2, 3])),
        /RequestTimeout/
    );

    const put = client.commands.find((command) => command instanceof PutObjectCommand);
    const deletion = client.commands.find((command) => command instanceof DeleteObjectCommand);
    assert.ok(put instanceof PutObjectCommand);
    assert.ok(deletion instanceof DeleteObjectCommand);
    assert.equal(deletion.input.Key, put.input.Key);
    assert.equal(client.hasObject('ims-media-prod', put.input.Key!), true);

    const operation = await connection.prepare(
        'SELECT object_id, physical_key, state FROM s3_upload_operations WHERE logical_key=?'
    ).bind(key).first<{
        object_id: string;
        physical_key: string;
        state: string;
    }>();
    assert.ok(operation);
    assert.equal(operation.physical_key, put.input.Key);
    assert.equal(operation.state, 'deleted');
    assert.equal(await state.isObjectReferenced(operation.object_id), false);

    const cleanup = await connection.prepare(
        `SELECT payload_json, state FROM s3_compensation_jobs
         WHERE kind='delete-s3-object'`
    ).first<{ payload_json: string; state: string }>();
    assert.ok(cleanup);
    assert.equal(cleanup.state, 'pending');
    assert.deepEqual(JSON.parse(cleanup.payload_json), {
        objectId: operation.object_id,
        physicalKey: operation.physical_key,
        storageScope: 'public'
    });

    await compensation.run(storage);
    assert.equal(client.hasObject('ims-media-prod', put.input.Key!), false);
    assert.equal((await connection.prepare(
        'SELECT state FROM s3_compensation_jobs WHERE kind=?'
    ).bind('delete-s3-object').first<{ state: string }>())?.state, 'completed');
});

test('S3 object storage keeps owner tokens out of user metadata', async (t) => {
    const { client, state, storage } = await fixture(t);
    const key = 'chronicle/media/pending/private.webp';
    await storage.put(key, new Uint8Array([4, 5, 6]), {
        ownerToken: 'owner-secret',
        metadata: {
            classification: 'internal',
            OwnerToken: 'metadata-secret'
        }
    });

    const snapshot = await state.snapshot(key);
    assert.ok(snapshot);
    assert.equal(snapshot.ownerToken, 'owner-secret');
    const metadata = client.object('ims-media-prod', snapshot.physicalKey!)?.metadata;
    assert.equal(metadata?.classification, 'internal');
    assert.equal(
        Object.keys(metadata || {}).some((name) => name.toLowerCase() === 'ownertoken'),
        false
    );
});

test('S3 physical keys support both an optional custom prefix and no prefix', () => {
    assert.equal(s3PhysicalObjectKey({
        bucket: 'private',
        prefix: 'tenant/site-a',
        readUrlTtlSeconds: 300
    }, 'wiki/agencies/sc/branding/icon.webp', 'object-id'),
    'tenant/site-a/wiki/agencies/sc/branding/objects/object-id/icon.webp');
    assert.equal(s3PhysicalObjectKey({
        bucket: 'private',
        readUrlTtlSeconds: 300
    }, 'wiki/agencies/sc/branding/icon.webp', 'object-id'),
    'wiki/agencies/sc/branding/objects/object-id/icon.webp');
    assert.equal(s3PhysicalObjectKey({
        bucket: 'single',
        prefix: 'tenant/site-a',
        readUrlTtlSeconds: 300
    }, 'site-packages/package/source.zip', 'object-id', 'private'),
    'tenant/site-a/__protected/site-packages/package/objects/object-id/source.zip');
});

test('S3 object storage signs GET and HEAD reads without proxying object bodies', async (t) => {
    const { signed, state, storage } = await fixture(t);
    const key = 'uploads/news/original/a b.webp';
    await storage.put(key, new Uint8Array([1, 2, 3]), { contentType: 'image/webp' });

    const snapshot = await state.snapshot(key);
    assert.ok(snapshot);
    assert.deepEqual(await storage.createReadUrl(key), {
        url: `https://media.example.test/${encodeURIComponent(
            `ims/production/uploads/news/original/objects/` +
            `${snapshot.objectId}/a b.webp`
        )}`,
        visibility: 'private'
    });
    assert.ok(signed[0]?.command instanceof GetObjectCommand);
    assert.equal(signed[0]?.expiresIn, 300);

    await storage.createReadUrl(key, { method: 'HEAD' });
    assert.ok(signed[1]?.command instanceof HeadObjectCommand);
    assert.equal(await storage.createReadUrl('uploads/news/original/missing.webp'), null);
    assert.equal(signed.length, 2);
});

test('S3 public and protected objects share one bucket with distinct read paths', async (t) => {
    const { client, signed, state, storage } = await fixture(t, {
        publicReadUrlBase: 'https://media.example.test/bucket-root',
        prefix: 'tenant/site-a'
    });
    const key = 'wiki/agencies/sc/idols/mano/story-images/card 01.webp';
    await storage.put(key, new Uint8Array([1, 2, 3]), { contentType: 'image/webp' });
    const snapshot = await state.snapshot(key);
    assert.ok(snapshot);
    assert.equal(snapshot.storageScope, 'public');
    assert.equal(client.hasObject('ims-media-prod', snapshot.physicalKey!), true);
    const commandsBeforePublicUrl = client.commands.length;
    assert.equal(
        await storage.createPublicReadUrl(key),
        'https://media.example.test/bucket-root/' +
            snapshot.physicalKey!.split('/').map(encodeURIComponent).join('/')
    );
    assert.equal(
        client.commands.length,
        commandsBeforePublicUrl,
        'public response URL resolution must not issue an S3 HEAD request'
    );
    assert.deepEqual(await storage.createReadUrl(key), {
        url: 'https://media.example.test/bucket-root/' +
            snapshot.physicalKey!.split('/').map(encodeURIComponent).join('/'),
        visibility: 'public'
    });
    assert.equal(signed.length, 0);

    const namecardKey = 'community/namecards/assets/mano/image.webp';
    await storage.put(namecardKey, new Uint8Array([4]), { protectedAccess: true });
    const pendingNamecard = await state.snapshot(namecardKey);
    assert.ok(pendingNamecard);
    assert.equal(pendingNamecard.state, 'ready');
    assert.equal(pendingNamecard.storageScope, 'private');
    assert.match(pendingNamecard.physicalKey!, /\/__protected\/community\/namecards\//);
    assert.equal(await storage.createPublicReadUrl(namecardKey), null);
    assert.equal((await storage.createReadUrl(namecardKey))?.visibility, 'private');
    await storage.publish(namecardKey);
    const publishedNamecard = await state.snapshot(namecardKey);
    assert.ok(publishedNamecard);
    assert.equal(publishedNamecard.storageScope, 'public');
    assert.equal((await storage.createReadUrl(namecardKey))?.visibility, 'public');
    assert.equal(client.hasObject('ims-media-prod', pendingNamecard.physicalKey!), false);
    assert.match(
        await storage.createPublicReadUrl(namecardKey) ?? '',
        /^https:\/\/media\.example\.test\/bucket-root\//
    );

    const readyInternalKey = 'site-packages/example/revisions/one/source.zip';
    await storage.put(readyInternalKey, new Uint8Array([5]));
    const readyInternal = await state.snapshot(readyInternalKey);
    assert.ok(readyInternal);
    assert.equal(readyInternal.storageScope, 'public');
    assert.doesNotMatch(readyInternal.physicalKey!, /\/__protected\//);
    assert.equal(client.hasObject('ims-media-prod', readyInternal.physicalKey!), true);
    assert.equal((await storage.createReadUrl(readyInternalKey))?.visibility, 'public');
});

test('S3 deferred public media stays private until publication moves it', async (t) => {
    const { client, state, storage } = await fixture(t, {
        publicReadUrlBase: 'https://media.example.test'
    });
    const key = 'editorial/events/assets/new-event/poster.webp';
    await storage.put(key, new Uint8Array([1, 2, 3]), {
        contentType: 'image/webp',
        deferredPublication: true
    });
    const pending = await state.snapshot(key);
    assert.ok(pending);
    assert.equal(pending.state, 'pending');
    assert.equal(pending.storageScope, 'private');
    assert.equal(client.hasObject('ims-media-prod', pending.physicalKey!), true);
    assert.match(pending.physicalKey!, /\/__protected\/editorial\/events\/assets\//);
    assert.equal(await storage.createReadUrl(key), null);

    await storage.publish(key);
    const published = await state.snapshot(key);
    assert.ok(published);
    assert.equal(published.state, 'ready');
    assert.equal(published.storageScope, 'public');
    assert.equal(client.hasObject('ims-media-prod', published.physicalKey!), true);
    assert.equal(client.hasObject('ims-media-prod', pending.physicalKey!), false);
    const copy = client.commands.find((command) => command instanceof CopyObjectCommand);
    assert.ok(copy instanceof CopyObjectCommand);
    assert.equal(copy.input.Bucket, 'ims-media-prod');
    assert.match(
        decodeURIComponent(copy.input.CopySource!),
        /^ims-media-prod\/ims\/production\/__protected\//
    );
});

test('S3 compensation preserves public access scope after a delete failure', async (t) => {
    const { client, compensation, state, storage } = await fixture(t, {
        publicReadUrlBase: 'https://media.example.test'
    });
    const key = 'wiki/shared/compensation/public.webp';
    await storage.put(key, new Uint8Array([1]));
    const snapshot = await state.snapshot(key);
    assert.ok(snapshot);
    assert.equal(snapshot.storageScope, 'public');
    client.deleteFailuresRemaining = 1;

    await storage.delete(key);
    assert.equal(client.hasObject('ims-media-prod', snapshot.physicalKey!), true);
    await compensation.run(storage);
    assert.equal(client.hasObject('ims-media-prod', snapshot.physicalKey!), false);
});

test('S3 deferred publication hides new objects and restores the previous version on rollback', async (t) => {
    const { storage } = await fixture(t);
    const initialKey = 'uploads/news/original/initial-deferred.webp';
    const initial = new TextEncoder().encode('initial');
    await storage.put(initialKey, initial, { deferredPublication: true });
    assert.equal(await storage.get(initialKey), null);
    assert.equal(await storage.createReadUrl(initialKey), null);
    assert.equal((await storage.list('uploads/news/original/')).some(
        (object) => object.key === initialKey
    ), false);
    await storage.publish(initialKey);
    assert.deepEqual((await storage.get(initialKey))?.body, initial);

    const key = 'uploads/news/original/deferred.webp';
    const previous = new TextEncoder().encode('previous');
    const replacement = new TextEncoder().encode('replacement');

    await storage.put(key, previous, { contentType: 'image/webp' });
    await storage.put(key, replacement, {
        contentType: 'image/webp',
        deferredPublication: true
    });
    assert.deepEqual((await storage.get(key))?.body, previous);

    await storage.delete(key);
    assert.deepEqual((await storage.get(key))?.body, previous);

    await storage.put(key, replacement, {
        contentType: 'image/webp',
        deferredPublication: true
    });
    assert.deepEqual((await storage.get(key))?.body, previous);
    await storage.publish(key);
    assert.deepEqual((await storage.get(key))?.body, replacement);
});

test('S3 listings resolve all readable versions with one metadata query', async (t) => {
    const { connection, storage } = await fixture(t);
    const prefix = 'wiki/agencies/sc/branding/';
    const replacedKey = `${prefix}icon.webp`;
    const readyKey = `${prefix}wordmark.webp`;
    const hiddenKey = `${prefix}draft.webp`;

    await storage.put(replacedKey, new Uint8Array([1]));
    await storage.put(replacedKey, new Uint8Array([2, 3]), {
        deferredPublication: true
    });
    await storage.put(readyKey, new Uint8Array([4, 5, 6]));
    await storage.put(hiddenKey, new Uint8Array([7]), {
        deferredPublication: true
    });

    const originalPrepare = connection.prepare.bind(connection);
    let metadataQueries = 0;
    connection.prepare = (sql: string) => {
        metadataQueries += 1;
        return originalPrepare(sql);
    };

    const listed = await storage.list(prefix);
    assert.equal(metadataQueries, 1);
    assert.deepEqual(listed, [
        { key: replacedKey, size: 1, etag: '"etag-1"' },
        { key: readyKey, size: 3, etag: '"etag-3"' }
    ]);
});

test('S3 ignores objects that have no managed semantic-key index', async (t) => {
    const { client, storage } = await fixture(t);
    const key = 'Data/sc/mano/card.webp';
    const physicalKey = `ims/production/${key}`;
    client.setObject('ims-media-prod', physicalKey, {
        body: new Uint8Array([1, 2]),
        contentType: 'image/webp',
        etag: '"legacy"',
        lastModified: new Date('2026-07-22T00:00:00Z')
    });

    assert.equal(await storage.get(key), null);
    assert.deepEqual(await storage.list('Data/sc/'), []);
});

test('S3 lifecycle fences owner and object identity mutations', async (t) => {
    const { state, storage } = await fixture(t);
    const key = 'chronicle/media/pending/a.webp';
    await storage.put(key, new Uint8Array([1, 2, 3]), { ownerToken: 'owner-a' });
    const first = await state.snapshot(key);
    assert.ok(first);

    assert.equal(await storage.deleteIfOwned(key, 'owner-b'), false);
    assert.equal(await storage.exists(key), true);
    await storage.put(key, new Uint8Array([4, 5, 6]), { ownerToken: 'owner-a' });
    assert.equal(await storage.deleteIfObjectId(key, first.objectId), false);
    assert.equal(await storage.moveIfOwned(key, `${key}.moved`, 'owner-b'), false);
    assert.equal(await storage.moveIfOwned(key, `${key}.moved`, 'owner-a'), true);
    assert.equal(await storage.exists(key), false);
    assert.deepEqual((await storage.get(`${key}.moved`))?.body, new Uint8Array([4, 5, 6]));
});

test('S3 stale recovery and SQL compensation remove unreferenced physical versions', async (t) => {
    const { client, compensation, connection, state, storage } = await fixture(t);
    const staleKey = 'editorial/events/assets/stale/poster.webp';
    await storage.put(staleKey, new Uint8Array([1]), { deferredPublication: true });
    const stale = await state.snapshot(staleKey);
    assert.ok(stale);
    await connection.prepare(
        'UPDATE s3_upload_operations SET updated_at=0 WHERE id=?'
    ).bind(stale.operationId).run();
    await storage.recoverStaleUploads(10, 1);
    assert.equal(await storage.get(staleKey), null);
    assert.equal(client.hasObject(
        'ims-media-prod',
        `ims/production/editorial/events/assets/stale/objects/${stale.objectId}/poster.webp`
    ), false);
    await compensation.run(storage);

    const compensatedKey = 'uploads/events/original/compensated.webp';
    await storage.put(compensatedKey, new Uint8Array([2]));
    client.deleteFailuresRemaining = 1;
    await storage.delete(compensatedKey);
    assert.equal(await storage.get(compensatedKey), null);
    assert.equal((await connection.prepare(
        `SELECT COUNT(*) AS count FROM s3_compensation_jobs WHERE state='pending'`
    ).first<{ count: number }>())?.count, 1);

    await compensation.run(storage);
    assert.equal((await connection.prepare(
        `SELECT COUNT(*) AS count FROM s3_compensation_jobs WHERE state='pending'`
    ).first<{ count: number }>())?.count, 0);
    assert.equal((await connection.prepare(
        `SELECT COUNT(*) AS count FROM s3_compensation_jobs WHERE state='completed'`
    ).first<{ count: number }>())?.count, 2);
});
