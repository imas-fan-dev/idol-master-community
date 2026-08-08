import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import { ZipFile } from 'yazl';
import { createHonoApp } from '@/app';
import type { SitePackageRepository } from '@/ports/repositories';
import type {
    ListedObject,
    ObjectReadUrlOptions,
    ObjectStorage,
    PutObjectOptions,
    StoredObject
} from '@/ports/object-storage';
import { SqlCoreRepository } from '@/infra/db/repositories/core-repository';
import { PostgresqlSchemaStrategy } from '@/infra/db/postgresql/schema-strategy';
import { StreamingUploadParser } from '@/infra/http/busboy/upload-parser';
import { createPostgresTestDatabase } from './postgres-test-database';

async function createArchive(): Promise<Buffer> {
    const zip = new ZipFile();
    zip.addBuffer(
        Buffer.from('<!doctype html><html><body>uploaded</body></html>'),
        'index.html'
    );
    zip.end();
    const chunks: Buffer[] = [];
    for await (const chunk of zip.outputStream as Readable) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

class MemoryStorage implements ObjectStorage {
    readonly objects = new Map<string, StoredObject>();
    reads: string[] = [];
    readUrls: Array<{ key: string; method?: 'GET' | 'HEAD' }> = [];

    async get(key: string): Promise<StoredObject | null> {
        this.reads.push(key);
        return this.objects.get(key) || null;
    }

    async createReadUrl(key: string, options: ObjectReadUrlOptions = {}) {
        this.readUrls.push({ key, method: options.method });
        return this.objects.has(key)
            ? {
                url: `https://assets.example.test/${key}`,
                visibility: 'public' as const
            }
            : null;
    }

    async put(
        key: string,
        body: Uint8Array,
        options: PutObjectOptions = {}
    ): Promise<StoredObject> {
        const stored = {
            body,
            size: body.byteLength,
            contentType: options.contentType || 'application/octet-stream',
            etag: `"${crypto.createHash('sha256').update(body).digest('hex')}"`,
            uploadedAt: new Date(1_000)
        };
        this.objects.set(key, stored);
        return stored;
    }

    async delete(key: string): Promise<void> {
        this.objects.delete(key);
    }

    async exists(key: string): Promise<boolean> {
        return this.objects.has(key);
    }

    async copy(sourceKey: string, destinationKey: string): Promise<void> {
        const object = this.objects.get(sourceKey);
        if (!object) throw new Error('missing source');
        this.objects.set(destinationKey, object);
    }

    async move(sourceKey: string, destinationKey: string): Promise<void> {
        await this.copy(sourceKey, destinationKey);
        await this.delete(sourceKey);
    }

    async list(prefix: string): Promise<ListedObject[]> {
        return [...this.objects.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, object]) => ({ key, size: object.size, etag: object.etag }));
    }

    async deletePrefix(prefix: string): Promise<void> {
        for (const key of [...this.objects.keys()]) {
            if (key.startsWith(prefix)) this.objects.delete(key);
        }
    }
}

function revision(
    packageId: string,
    revisionId: string,
    token: string,
    runtimeMode: 'safe' | 'isolated-script',
    manifest: Record<string, string>,
    createdAt: number
) {
    const prefix = `site-packages/${packageId}/revisions/${revisionId}`;
    return {
        id: revisionId,
        packageId,
        entryPath: 'index.html',
        runtimeMode,
        state: 'ready' as const,
        fileCount: Object.keys(manifest).length,
        totalBytes: 100,
        sourceKey: `${prefix}/source.zip`,
        sourceSha256: 'c'.repeat(64),
        manifestKey: `${prefix}/manifest.json`,
        manifestJson: JSON.stringify(manifest),
        previewTokenHash: crypto.createHash('sha256').update(token).digest('hex'),
        createdBy: 1,
        createdAt
    };
}

test('site-package routes share the main origin and enforce manifests, CSP, and revisions', async (t) => {
    const repository = new SqlCoreRepository(
        await createPostgresTestDatabase(t, 'site-routes'),
        new PostgresqlSchemaStrategy()
    );
    t.after(() => repository.close());
    await repository.initialize();
    const storage = new MemoryStorage();
    const packageId = '11111111-1111-4111-8111-111111111111';
    const publishedId = '22222222-2222-4222-8222-222222222222';
    const previewId = '33333333-3333-4333-8333-333333333333';
    const publishedPrefix = `site-packages/${packageId}/revisions/${publishedId}`;
    const previewPrefix = `site-packages/${packageId}/revisions/${previewId}`;
    const publishedManifest = {
        'index.html': `${publishedPrefix}/files/index.html`,
        'fonts.css': `${publishedPrefix}/files/fonts.css`,
        'hero.webp': `${publishedPrefix}/files/hero.webp`,
        'email_template.txt': `${publishedPrefix}/files/email_template.txt`,
        'leak.txt': `${publishedPrefix}/source.zip`
    };
    await repository.createSitePackageWithRevision({
        id: packageId,
        slug: 'hiro-2026',
        title: 'Hiro 2026',
        description: 'Independent package',
        createdBy: 1,
        createdAt: 1_000
    }, revision(
        packageId,
        publishedId,
        'a'.repeat(64),
        'safe',
        publishedManifest,
        1_000
    ));
    await repository.createSitePackageRevision(revision(
        packageId,
        previewId,
        'b'.repeat(64),
        'isolated-script',
        {
            'index.html': `${previewPrefix}/files/index.html`,
            'preview.webp': `${previewPrefix}/files/preview.webp`
        },
        2_000
    ));
    await repository.publishSitePackageRevision(packageId, publishedId, 1, 3_000);
    await storage.put(
        `${publishedPrefix}/files/index.html`,
        new TextEncoder().encode(
            '<!doctype html><html><head><style>' +
            '@import url("assets/fonts/fonts.css"); body { color: black; }' +
            '</style></head><body>published</body></html>'
        ),
        { contentType: 'text/html; charset=utf-8' }
    );
    await storage.put(
        `${publishedPrefix}/files/fonts.css`,
        new TextEncoder().encode([
            '@font-face { font-family: Remote; src: url(https://fonts.example/remote.woff2); }',
            '@font-face { font-family: Local; src: url(local.woff2); }',
            'body { font-family: Local, sans-serif; }'
        ].join('\n')),
        { contentType: 'text/css; charset=utf-8' }
    );
    await storage.put(
        `${publishedPrefix}/files/email_template.txt`,
        new TextEncoder().encode('hello'),
        { contentType: 'text/plain; charset=utf-8' }
    );
    await storage.put(
        `${publishedPrefix}/files/hero.webp`,
        new Uint8Array([0x52, 0x49, 0x46, 0x46]),
        { contentType: 'image/webp' }
    );
    await storage.put(
        `${publishedPrefix}/source.zip`,
        new Uint8Array([0x50, 0x4b]),
        { contentType: 'application/zip' }
    );
    await storage.put(
        `${previewPrefix}/files/index.html`,
        new TextEncoder().encode(
            '<!doctype html><html><body><script>document.body.dataset.ok="1"</script></body></html>'
        ),
        { contentType: 'text/html; charset=utf-8' }
    );
    await storage.put(
        `${previewPrefix}/files/preview.webp`,
        new Uint8Array([0x52, 0x49, 0x46, 0x46]),
        { contentType: 'image/webp' }
    );

    const runtimeServices = {
        sitePackages: repository,
        audit: repository,
        storage,
        uploads: new StreamingUploadParser(),
        backofficeTokens: {
            sign: async () => 'op-token',
            verify: async (token: string) => {
                if (token !== 'op-token') throw new Error('invalid token');
                return {
                    id: 1,
                    username: 'operator',
                    producername: 'Operator',
                    dept: 'op',
                    csrfSecret: 'csrf'
                };
            }
        },
        config: {
            clientAddressSource: 'direct' as const
        }
    };
    const app = createHonoApp(() => runtimeServices);
    const nginxApp = createHonoApp(() => ({
        ...runtimeServices,
        config: {
            ...runtimeServices.config,
            clientAddressSource: 'nginx' as const
        }
    }));
    let throwAfterPackageCommit = true;
    let throwAfterRevisionCommit = true;
    const ambiguousRepository = new Proxy(repository as SitePackageRepository, {
        get(target, property) {
            if (property === 'createSitePackageWithRevision') {
                return async (...args: Parameters<SitePackageRepository['createSitePackageWithRevision']>) => {
                    await target.createSitePackageWithRevision(...args);
                    if (throwAfterPackageCommit) {
                        throwAfterPackageCommit = false;
                        throw new Error('connection lost after package commit');
                    }
                };
            }
            if (property === 'createSitePackageRevision') {
                return async (...args: Parameters<SitePackageRepository['createSitePackageRevision']>) => {
                    const result = await target.createSitePackageRevision(...args);
                    if (throwAfterRevisionCommit) {
                        throwAfterRevisionCommit = false;
                        throw new Error('connection lost after revision commit');
                    }
                    return result;
                };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
        }
    });
    const ambiguousApp = createHonoApp(() => ({
        ...runtimeServices,
        sitePackages: ambiguousRepository
    }));
    const limitedApp = createHonoApp(() => ({
        ...runtimeServices,
        config: {
            ...runtimeServices.config,
            sitePackageMaxUploadBytes: 64
        }
    }));

    const forwardedHeaders = {
        'x-forwarded-proto': 'http',
        'x-forwarded-host': 'main.test',
        'x-forwarded-port': '8080'
    };
    const forwardedContent = await nginxApp.request(
        `http://upstream.test/site-content/hiro-2026/${publishedId}/`,
        { headers: forwardedHeaders }
    );
    assert.equal(forwardedContent.status, 200);
    assert.equal(forwardedContent.headers.get('location'), null);
    assert.match(
        forwardedContent.headers.get('content-security-policy') || '',
        /frame-ancestors http:\/\/main\.test:8080/
    );
    const forwardedShell = await nginxApp.request(
        'http://upstream.test/sites/hiro-2026',
        { headers: forwardedHeaders }
    );
    assert.match(
        await forwardedShell.text(),
        new RegExp(`src="http://main\\.test:8080/site-content/hiro-2026/${publishedId}/"`)
    );
    const forwardedMetadata = await nginxApp.request(
        'http://upstream.test/api/site-packages/hiro-2026',
        { headers: forwardedHeaders }
    );
    assert.deepEqual(await forwardedMetadata.json(), {
        slug: 'hiro-2026',
        title: 'Hiro 2026',
        description: 'Independent package',
        revisionId: publishedId,
        revisionNumber: 1,
        runtimeMode: 'safe',
        publishedAt: 3_000,
        siteUrl: 'http://main.test:8080/sites/hiro-2026',
        contentUrl: `http://main.test:8080/site-content/hiro-2026/${publishedId}/`
    });
    assert.equal((await nginxApp.request('http://upstream.test/api/wiki/test', {
        headers: forwardedHeaders
    })).status, 200);

    assert.equal((await app.request('http://main.test/api/wiki/test')).status, 200);
    assert.equal((await app.request(
        `http://main.test/site-content/hiro-2026/${publishedId}/`,
        { method: 'POST' }
    )).status, 404);

    for (const [pathname, init] of [
        ['/api/admin/site-packages', undefined],
        ['/api/admin/site-packages', { method: 'POST' }]
    ] as const) {
        assert.equal((await app.request(`http://main.test${pathname}`, init)).status, 401);
    }
    const admin = await app.request('http://main.test/api/admin/site-packages', {
        headers: { authorization: 'Bearer op-token' }
    });
    assert.equal(admin.status, 200);
    const adminBody = await admin.json();
    assert.equal(adminBody.packages[0].revisions.length, 2);
    const serializedAdmin = JSON.stringify(adminBody);
    for (const privateField of [
        'source_key',
        'manifest_key',
        'manifest_json',
        'preview_token_hash'
    ]) {
        assert.doesNotMatch(serializedAdmin, new RegExp(privateField));
    }

    const keysBeforeDuplicate = new Set(storage.objects.keys());
    const duplicateUpload = new FormData();
    duplicateUpload.set('slug', 'hiro-2026');
    duplicateUpload.set('title', 'Duplicate');
    duplicateUpload.set('description', 'Must roll back objects');
    duplicateUpload.set('entryPath', 'index.html');
    duplicateUpload.set('runtimeMode', 'safe');
    const archive = await createArchive();
    const archiveBytes = new Uint8Array(archive.byteLength);
    archiveBytes.set(archive);

    const limitedUpload = new FormData();
    limitedUpload.set('slug', 'too-large-for-config');
    limitedUpload.set('title', 'Too large');
    limitedUpload.set('entryPath', 'index.html');
    limitedUpload.set('runtimeMode', 'safe');
    limitedUpload.set(
        'archive',
        new Blob([archiveBytes], { type: 'application/zip' }),
        'too-large.zip'
    );
    const objectsBeforeLimit = storage.objects.size;
    const limited = await limitedApp.request('http://main.test/api/admin/site-packages', {
        method: 'POST',
        headers: { authorization: 'Bearer op-token' },
        body: limitedUpload
    });
    assert.equal(limited.status, 413, await limited.text());
    assert.equal(storage.objects.size, objectsBeforeLimit);

    duplicateUpload.set(
        'archive',
        new Blob([archiveBytes], { type: 'application/zip' }),
        'duplicate.zip'
    );
    const duplicate = await app.request('http://main.test/api/admin/site-packages', {
        method: 'POST',
        headers: { authorization: 'Bearer op-token' },
        body: duplicateUpload
    });
    assert.equal(duplicate.status, 409, await duplicate.text());
    assert.deepEqual(
        new Set(storage.objects.keys()),
        keysBeforeDuplicate,
        'database conflicts clean every immutable object written for the failed revision'
    );

    const ambiguousUpload = new FormData();
    ambiguousUpload.set('slug', 'commit-confirmed');
    ambiguousUpload.set('title', 'Commit confirmed');
    ambiguousUpload.set('entryPath', 'index.html');
    ambiguousUpload.set('runtimeMode', 'safe');
    ambiguousUpload.set(
        'archive',
        new Blob([archiveBytes], { type: 'application/zip' }),
        'confirmed.zip'
    );
    const ambiguousCreate = await ambiguousApp.request(
        'http://main.test/api/admin/site-packages',
        {
            method: 'POST',
            headers: { authorization: 'Bearer op-token' },
            body: ambiguousUpload
        }
    );
    assert.equal(ambiguousCreate.status, 201);
    const ambiguousCreateBody = await ambiguousCreate.json();
    const committedFirstRevision = await repository.findSitePackageRevisionById(
        ambiguousCreateBody.packageId,
        ambiguousCreateBody.revisionId
    );
    assert.ok(committedFirstRevision);
    assert.equal(await storage.exists(committedFirstRevision.source_key), true);
    assert.equal(await storage.exists(committedFirstRevision.manifest_key), true);

    const ambiguousRevisionUpload = new FormData();
    ambiguousRevisionUpload.set('entryPath', 'index.html');
    ambiguousRevisionUpload.set('runtimeMode', 'safe');
    ambiguousRevisionUpload.set(
        'archive',
        new Blob([archiveBytes], { type: 'application/zip' }),
        'confirmed-revision.zip'
    );
    const ambiguousRevision = await ambiguousApp.request(
        `http://main.test/api/admin/site-packages/${ambiguousCreateBody.packageId}/revisions`,
        {
            method: 'POST',
            headers: { authorization: 'Bearer op-token' },
            body: ambiguousRevisionUpload
        }
    );
    assert.equal(ambiguousRevision.status, 201);
    const ambiguousRevisionBody = await ambiguousRevision.json();
    assert.equal(ambiguousRevisionBody.revision.revisionNumber, 2);
    const committedSecondRevision = await repository.findSitePackageRevisionById(
        ambiguousCreateBody.packageId,
        ambiguousRevisionBody.revision.id
    );
    assert.ok(committedSecondRevision);
    assert.equal(await storage.exists(committedSecondRevision.source_key), true);
    assert.equal(await storage.exists(committedSecondRevision.manifest_key), true);

    const metadata = await app.request('http://main.test/api/site-packages/hiro-2026');
    assert.equal(metadata.status, 200);
    const metadataBody = await metadata.json();
    assert.equal(metadataBody.revisionId, publishedId);
    assert.equal(metadataBody.siteUrl, 'http://main.test/sites/hiro-2026');
    assert.equal(
        metadataBody.contentUrl,
        `http://main.test/site-content/hiro-2026/${publishedId}/`
    );
    const stable = await app.request('http://main.test/sites/hiro-2026');
    assert.equal(stable.status, 200);
    assert.match(
        await stable.text(),
        new RegExp(`src="http://main\\.test/site-content/hiro-2026/${publishedId}/"`)
    );
    assert.match(stable.headers.get('content-security-policy') || '',
        /frame-src http:\/\/main\.test/);
    assert.equal(stable.headers.get('x-frame-options'), 'DENY');

    const published = await app.request(
        `http://main.test/site-content/hiro-2026/${publishedId}/`
    );
    assert.equal(published.status, 200);
    const publishedText = await published.text();
    assert.match(publishedText, /published/);
    assert.match(publishedText, /body \{ color: black; \}/);
    assert.doesNotMatch(publishedText, /fonts\/fonts\.css|@import/);
    assert.equal(published.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
    assert.equal(published.headers.get('x-frame-options'), null);
    assert.match(published.headers.get('content-security-policy') || '', /script-src 'none'/);
    assert.match(published.headers.get('content-security-policy') || '', /frame-ancestors http:\/\/main\.test/);
    assert.match(
        published.headers.get('content-security-policy') || '',
        /img-src 'self' data: https:\/\/assets\.example\.test/
    );

    const stylesheet = await app.request(
        `http://main.test/site-content/hiro-2026/${publishedId}/fonts.css`
    );
    const stylesheetText = await stylesheet.text();
    assert.equal(stylesheet.status, 200);
    assert.equal(stylesheet.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.doesNotMatch(stylesheetText, /fonts\.example|font-family: Remote/);
    assert.match(stylesheetText, /font-family: Local|url\(local\.woff2\)/);
    assert.equal(
        stylesheet.headers.get('content-length'),
        String(new TextEncoder().encode(stylesheetText).byteLength)
    );

    const textAsset = await app.request(
        `http://main.test/site-content/hiro-2026/${publishedId}/email_template.txt`
    );
    assert.equal(textAsset.status, 200);
    assert.equal(await textAsset.text(), 'hello');

    const readsBeforeDirectAsset = storage.reads.length;
    const directAssetUrl =
        `http://main.test/site-content/hiro-2026/${publishedId}/hero.webp`;
    const directAsset = await app.request(directAssetUrl);
    assert.equal(directAsset.status, 307);
    assert.equal(
        directAsset.headers.get('location'),
        `https://assets.example.test/${publishedPrefix}/files/hero.webp`
    );
    assert.equal(
        directAsset.headers.get('cache-control'),
        'public, max-age=31536000, immutable'
    );
    assert.equal(storage.reads.length, readsBeforeDirectAsset);
    const directAssetHead = await app.request(directAssetUrl, { method: 'HEAD' });
    assert.equal(directAssetHead.status, 307);
    assert.deepEqual(storage.readUrls.slice(-2).map((call) => call.method), ['GET', 'HEAD']);

    const readsBeforeDenials = storage.reads.length;
    for (const pathname of [
        `/site-content/hiro-2026/${publishedId}/source.zip`,
        `/site-content/hiro-2026/${publishedId}/manifest.json`,
        `/site-content/hiro-2026/${publishedId}/leak.txt`,
        `/site-content/hiro-2026/${publishedId}/%252e%252e/source.zip`
    ]) {
        const denied = await app.request(`http://main.test${pathname}`);
        assert.notEqual(denied.status, 200, pathname);
    }
    assert.equal(storage.reads.length, readsBeforeDenials, 'denied paths do not reach storage');

    const preview = await app.request(
        `http://main.test/site-content/_preview/${'b'.repeat(64)}/`
    );
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('cache-control'), 'private, no-store');
    const previewCsp = preview.headers.get('content-security-policy') || '';
    assert.match(previewCsp, /script-src 'self' 'unsafe-inline'/);
    assert.match(previewCsp, /sandbox allow-scripts/);
    assert.doesNotMatch(previewCsp, /allow-same-origin|allow-forms|allow-top-navigation/);
    const previewAsset = await app.request(
        `http://main.test/site-content/_preview/${'b'.repeat(64)}/preview.webp`
    );
    assert.equal(previewAsset.status, 200);
    assert.equal(previewAsset.headers.get('cache-control'), 'private, no-store');
    assert.equal(previewAsset.headers.get('location'), null);

    const rotated = await app.request(
        `http://main.test/api/admin/site-packages/${packageId}/revisions/${previewId}/preview-token`,
        { method: 'POST', headers: { authorization: 'Bearer op-token' } }
    );
    assert.equal(rotated.status, 200);
    const rotatedBody = await rotated.json();
    assert.match(rotatedBody.previewToken, /^[a-f0-9]{64}$/);
    assert.equal(
        rotatedBody.previewUrl,
        `http://main.test/site-content/_preview/${rotatedBody.previewToken}/`
    );
    assert.equal((await app.request(
        `http://main.test/site-content/_preview/${'b'.repeat(64)}/`
    )).status, 404, 'rotating a token invalidates the previous bearer URL');
    assert.equal((await app.request(rotatedBody.previewUrl)).status, 200);

    const publishSecond = await app.request(
        `http://main.test/api/admin/site-packages/${packageId}/revisions/${previewId}/publish`,
        { method: 'POST', headers: { authorization: 'Bearer op-token' } }
    );
    assert.equal(publishSecond.status, 200);
    const publishSecondBody = await publishSecond.json();
    assert.equal(publishSecondBody.operation, 'publish');
    assert.equal(
        publishSecondBody.publishedAt,
        (await repository.findSitePackageRevisionById(packageId, previewId))?.published_at
    );
    assert.equal((await repository.listRecentAuditLogs(1))[0]?.action, '发布站点包版本');
    const readsBeforeOldRevision = storage.reads.length;
    assert.equal((await app.request(
        `http://main.test/site-content/hiro-2026/${publishedId}/`
    )).status, 404, 'a historical revision is not a public content URL');
    assert.equal(storage.reads.length, readsBeforeOldRevision);
    assert.equal((await app.request(
        `http://main.test/site-content/hiro-2026/${previewId}/`
    )).status, 200);
    assert.equal((await app.request(
        `http://main.test/site-content/_preview/${'a'.repeat(64)}/`
    )).status, 200, 'historical revisions remain available through their preview token');
    assert.match(
        await (await app.request('http://main.test/sites/hiro-2026')).text(),
        new RegExp(`/site-content/hiro-2026/${previewId}/`)
    );

    const rollback = await app.request(
        `http://main.test/api/admin/site-packages/${packageId}/revisions/${publishedId}/publish`,
        { method: 'POST', headers: { authorization: 'Bearer op-token' } }
    );
    assert.equal(rollback.status, 200);
    const rollbackBody = await rollback.json();
    assert.equal(rollbackBody.operation, 'rollback');
    assert.equal(rollbackBody.publishedAt, 3_000);
    assert.equal((await repository.listRecentAuditLogs(1))[0]?.action, '回滚站点包版本');
    assert.equal((await app.request(
        `http://main.test/site-content/hiro-2026/${previewId}/`
    )).status, 404);
    assert.equal((await app.request(
        `http://main.test/site-content/hiro-2026/${publishedId}/`
    )).status, 200);
    assert.match(
        await (await app.request('http://main.test/sites/hiro-2026')).text(),
        new RegExp(`/site-content/hiro-2026/${publishedId}/`)
    );

    const auditCountBeforeFailedPublish = (await repository.listRecentAuditLogs(100)).length;
    const failedPublish = await app.request(
        `/api/admin/site-packages/${packageId}/revisions/` +
        '44444444-4444-4444-8444-444444444444/publish',
        { method: 'POST', headers: { authorization: 'Bearer op-token' } }
    );
    assert.equal(failedPublish.status, 404);
    assert.equal(
        (await repository.listRecentAuditLogs(100)).length,
        auditCountBeforeFailedPublish,
        'a failed publication must not append an audit record'
    );

    const head = await app.request(
        `http://main.test/site-content/hiro-2026/${publishedId}/`,
        { method: 'HEAD' }
    );
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
});
