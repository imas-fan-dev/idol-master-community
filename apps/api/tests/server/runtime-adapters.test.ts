import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { test } from 'node:test';
import {
    brotliCompressSync,
    brotliDecompressSync,
    gzipSync,
    gunzipSync
} from 'node:zlib';
import { FilesystemCompensationService } from '@/infra/oss/filesystem/compensation-service';
import { FilesystemIdempotencyStore } from '@/infra/cache/filesystem/idempotency-store';
import { FilesystemObjectStorage } from '@/infra/oss/filesystem/object-storage';
import {
    FrontendStaticAssets,
    listFrontendFiles,
    NodeStaticAssets
} from '@/infra/http/filesystem/static-assets';
import type { ObjectStorage } from '@/ports/object-storage';
import type { RuntimeServices } from '@/ports/runtime-services';
import {
    createNodeServiceLifecycle,
    initializeNodeRepositories,
    validateFudabaPublicReadStorage
} from '@/runtime/node-services';
import {
    parseClientAddressSource,
    parseFudabaMapConfig,
    parseFudabaMapEnabled,
    parseFudabaMapStyleUrl,
    parseFudabaPublicReadEnabled,
    parseFudabaWriteEnabled,
    parseStoryMaxUploadBytes
} from '@/config/env';
import { parseNodeDatabaseConfig } from '@/config/database';
import { parseNodeObjectStorageConfig } from '@/config/object-storage';
import { shutdownServer } from '@/main';

async function temporaryDirectory(prefix: string): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('Node repository initialization closes every constructed resource after partial failure', async () => {
    const calls: string[] = [];
    const core = {
        async initialize() { calls.push('core:init'); },
        async close() { calls.push('core:close'); }
    };
    const platform = {
        async initialize() { calls.push('platform:init'); },
        async close() { calls.push('platform:close'); }
    };
    const fudaba = {
        async initialize() { calls.push('fudaba:init'); },
        async close() { calls.push('fudaba:close'); }
    };
    const story = {
        async initialize() { calls.push('story:init'); throw new Error('story init failed'); },
        async close() { calls.push('story:close'); }
    };

    await assert.rejects(
        initializeNodeRepositories(core, platform, fudaba, story),
        /story init failed/
    );
    assert.deepEqual(calls, [
        'core:init',
        'platform:init',
        'fudaba:init',
        'story:init',
        'story:close',
        'fudaba:close',
        'platform:close',
        'core:close'
    ]);
});

test('graceful shutdown stops HTTP acceptance before closing runtime services', async () => {
    const server = createServer((_request, response) => response.end('ok'));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    let closes = 0;

    await shutdownServer(server, {
        timeoutMs: 1_000,
        async closeServices() {
            closes += 1;
        }
    });

    assert.equal(server.listening, false);
    assert.equal(closes, 1);
});

test('story upload byte limit accepts only a positive bounded safe integer', () => {
    assert.equal(parseStoryMaxUploadBytes(undefined), 50 * 1024 * 1024);
    assert.equal(parseStoryMaxUploadBytes('1'), 1);
    assert.equal(parseStoryMaxUploadBytes('52428800'), 50 * 1024 * 1024);
    for (const value of ['', 'abc', '0', '-1', '1.5', 'Infinity', '52428801']) {
        assert.throws(() => parseStoryMaxUploadBytes(value), /IMS_STORY_MAX_UPLOAD_BYTES must be/);
    }
});

test('Node trusts proxy address headers only when Nginx is explicit', () => {
    assert.equal(parseClientAddressSource(undefined), 'direct');
    assert.equal(parseClientAddressSource(' nginx '), 'nginx');
    assert.throws(
        () => parseClientAddressSource('automatic'),
        /IMS_CLIENT_ADDRESS_SOURCE must be direct or nginx/
    );
});

test('Fudaba public reads require an explicit boolean feature flag', () => {
    assert.equal(parseFudabaPublicReadEnabled(undefined), false);
    assert.equal(parseFudabaPublicReadEnabled(' true '), true);
    assert.equal(parseFudabaPublicReadEnabled('0'), false);
    assert.throws(
        () => parseFudabaPublicReadEnabled('enabled'),
        /IMS_FUDABA_PUBLIC_READ_ENABLED must be true or false/
    );
});

test('Fudaba writes use an independent explicit boolean feature flag', () => {
    assert.equal(parseFudabaWriteEnabled(undefined), false);
    assert.equal(parseFudabaWriteEnabled(' yes '), true);
    assert.equal(parseFudabaWriteEnabled('off'), false);
    assert.throws(
        () => parseFudabaWriteEnabled('enabled'),
        /IMS_FUDABA_WRITE_ENABLED must be true or false/
    );
});

test('Fudaba map configuration is disabled by default and strictly parsed', () => {
    assert.deepEqual(parseFudabaMapConfig({}), {
        enabled: false,
        styleUrl: ''
    });
    assert.equal(parseFudabaMapEnabled(' true '), true);
    assert.equal(parseFudabaMapEnabled('FALSE'), false);
    for (const value of ['1', '0', 'yes', 'on', 'enabled']) {
        assert.throws(
            () => parseFudabaMapEnabled(value),
            /IMS_FUDABA_MAP_ENABLED must be true or false/
        );
    }
    assert.deepEqual(parseFudabaMapConfig({
        IMS_FUDABA_MAP_ENABLED: 'true',
        IMS_FUDABA_MAP_STYLE_URL: ' /api/community/exchange/map/style.json '
    }), {
        enabled: true,
        styleUrl: '/api/community/exchange/map/style.json'
    });
    assert.throws(
        () => parseFudabaMapConfig({ IMS_FUDABA_MAP_ENABLED: 'true' }),
        /IMS_FUDABA_MAP_STYLE_URL is required when IMS_FUDABA_MAP_ENABLED=true/
    );
});

test('Fudaba map style accepts only a same-origin absolute path', () => {
    assert.equal(parseFudabaMapStyleUrl(undefined), '');
    assert.equal(parseFudabaMapStyleUrl('   '), '');
    assert.equal(
        parseFudabaMapStyleUrl('/api/community/exchange/map/style.json'),
        '/api/community/exchange/map/style.json'
    );
    for (const value of [
        'style.json',
        'https://tiles.example.test/style.json',
        '//tiles.example.test/style.json',
        '/styles//map.json',
        '/styles\\map.json',
        '/styles/map.json?key=secret',
        '/styles/map.json#layer',
        '/styles/map\n.json',
        `/styles/${'x'.repeat(2048)}`
    ]) {
        assert.throws(
            () => parseFudabaMapStyleUrl(value),
            /IMS_FUDABA_MAP_STYLE_URL must be a same-origin absolute path/
        );
    }
});

test('Fudaba public reads require S3 public object URL configuration', () => {
    assert.doesNotThrow(() => validateFudabaPublicReadStorage(false, {
        type: 's3',
        bucket: 'imsweb-media',
        region: 'us-east-1',
        forcePathStyle: false,
        prefix: '',
        readUrlTtlSeconds: 300
    }));
    assert.doesNotThrow(() => validateFudabaPublicReadStorage(true, {
        type: 's3',
        bucket: 'imsweb-media',
        publicReadUrlBase: 'https://media.example.test',
        region: 'us-east-1',
        forcePathStyle: false,
        prefix: '',
        readUrlTtlSeconds: 300
    }));
    assert.throws(
        () => validateFudabaPublicReadStorage(true, { type: 'filesystem' }),
        /IMS_OBJECT_STORAGE=s3 is required/
    );
    assert.throws(
        () => validateFudabaPublicReadStorage(true, {
            type: 's3',
            bucket: 'imsweb-media',
            region: 'us-east-1',
            forcePathStyle: false,
            prefix: '',
            readUrlTtlSeconds: 300
        }),
        /IMS_PUBLIC_READ_URL_BASE is required/
    );
});

test('early close does not poison a later Node service and concurrent close is idempotent', async () => {
    let creates = 0;
    let coreCloses = 0;
    let platformCloses = 0;
    let fudabaCloses = 0;
    let storyCloses = 0;
    let storageCloses = 0;
    const lifecycle = createNodeServiceLifecycle(async () => {
        creates += 1;
        return {
            backofficeAuth: { close: async () => { coreCloses += 1; } },
            platformAccounts: { close: async () => { platformCloses += 1; } },
            fudaba: { close: async () => { fudabaCloses += 1; } },
            story: { close: async () => { storyCloses += 1; } },
            storage: { close: () => { storageCloses += 1; } }
        } as unknown as RuntimeServices;
    });

    await lifecycle.close();
    await lifecycle.resolve();
    await Promise.all([lifecycle.close(), lifecycle.close()]);
    assert.deepEqual(
        { creates, coreCloses, platformCloses, fudabaCloses, storyCloses, storageCloses },
        {
            creates: 1,
            coreCloses: 1,
            platformCloses: 1,
            fudabaCloses: 1,
            storyCloses: 1,
            storageCloses: 1
        }
    );

    await lifecycle.resolve();
    await lifecycle.close();
    assert.deepEqual(
        { creates, coreCloses, platformCloses, fudabaCloses, storyCloses, storageCloses },
        {
            creates: 2,
            coreCloses: 2,
            platformCloses: 2,
            fudabaCloses: 2,
            storyCloses: 2,
            storageCloses: 2
        }
    );
});

test('Node object storage defaults to S3 and requires explicit filesystem compatibility', () => {
    assert.throws(
        () => parseNodeObjectStorageConfig({}),
        /IMS_S3_BUCKET is required/
    );
    assert.deepEqual(parseNodeObjectStorageConfig({
        IMS_OBJECT_STORAGE: 'filesystem'
    }), { type: 'filesystem' });
    assert.deepEqual(parseNodeObjectStorageConfig({
        IMS_OBJECT_STORAGE: 'filesystem',
        IMS_PUBLIC_READ_URL_BASE: 'https://media.example.test/assets/'
    }), {
        type: 'filesystem',
        publicReadUrlBase: 'https://media.example.test/assets'
    });
    assert.deepEqual(parseNodeObjectStorageConfig({
        IMS_OBJECT_STORAGE: ' S3 ',
        IMS_S3_BUCKET: 'ims-media-prod',
        AWS_REGION: 'ap-northeast-1',
        IMS_S3_ENDPOINT: 'https://objects.example.test/',
        IMS_S3_FORCE_PATH_STYLE: 'yes',
        IMS_S3_PREFIX: '/ims/production/'
    }), {
        type: 's3',
        bucket: 'ims-media-prod',
        region: 'ap-northeast-1',
        endpoint: 'https://objects.example.test',
        forcePathStyle: true,
        prefix: 'ims/production',
        readUrlTtlSeconds: 300
    });

    assert.throws(
        () => parseNodeObjectStorageConfig({ IMS_OBJECT_STORAGE: 's3' }),
        /IMS_S3_BUCKET is required/
    );
    assert.throws(
        () => parseNodeObjectStorageConfig({
            IMS_OBJECT_STORAGE: 's3',
            IMS_S3_BUCKET: 'ims-media-prod'
        }),
        /IMS_S3_REGION or AWS_REGION is required/
    );
    assert.throws(
        () => parseNodeObjectStorageConfig({ IMS_OBJECT_STORAGE: 'database' }),
        /filesystem or s3/
    );
    assert.throws(
        () => parseNodeObjectStorageConfig({
            IMS_OBJECT_STORAGE: 's3',
            IMS_S3_BUCKET: 'ims-media-prod',
            IMS_S3_REGION: 'ap-northeast-1',
            IMS_S3_FORCE_PATH_STYLE: 'sometimes'
        }),
        /must be true or false/
    );
    assert.throws(
        () => parseNodeObjectStorageConfig({
            IMS_OBJECT_STORAGE: 's3',
            IMS_S3_BUCKET: 'ims-media-prod',
            IMS_S3_REGION: 'ap-northeast-1',
            IMS_S3_READ_URL_TTL_SECONDS: '10'
        }),
        /IMS_S3_READ_URL_TTL_SECONDS must be/
    );
    assert.deepEqual(parseNodeObjectStorageConfig({
        IMS_OBJECT_STORAGE: 's3',
        IMS_S3_BUCKET: 'ims-media-prod',
        IMS_S3_PUBLIC_READ_URL_BASE: 'https://media.example.test/content/',
        IMS_S3_REGION: 'auto',
        IMS_S3_PREFIX: ''
    }), {
        type: 's3',
        bucket: 'ims-media-prod',
        publicReadUrlBase: 'https://media.example.test/content',
        region: 'auto',
        endpoint: undefined,
        forcePathStyle: false,
        prefix: '',
        readUrlTtlSeconds: 300
    });
    assert.throws(() => parseNodeObjectStorageConfig({
        IMS_OBJECT_STORAGE: 's3',
        IMS_S3_BUCKET: 'ims-media-prod',
        IMS_S3_PUBLIC_BUCKET: 'ims-public-prod',
        IMS_S3_REGION: 'auto'
    }), /no longer supported/);
    assert.throws(() => parseNodeObjectStorageConfig({
        IMS_OBJECT_STORAGE: 's3',
        IMS_S3_BUCKET: 'ims-media-prod',
        IMS_PUBLIC_READ_URL_BASE: 'https://media-a.example.test',
        IMS_S3_PUBLIC_READ_URL_BASE: 'https://media-b.example.test',
        IMS_S3_REGION: 'auto'
    }), /must match/);
    assert.deepEqual(parseNodeObjectStorageConfig({
        IMS_OBJECT_STORAGE: 's3',
        IMS_S3_BUCKET: 'ims-media-prod',
        IMS_S3_PUBLIC_READ_URL_BASE: 'https:\/\/media.example.test',
        IMS_S3_REGION: 'auto'
    }), {
        type: 's3',
        bucket: 'ims-media-prod',
        publicReadUrlBase: 'https://media.example.test',
        region: 'auto',
        endpoint: undefined,
        forcePathStyle: false,
        prefix: '',
        readUrlTtlSeconds: 300
    });
});

test('Node database accepts only a validated PostgreSQL configuration', () => {
    assert.throws(
        () => parseNodeDatabaseConfig({}),
        /DATABASE_URL is required/
    );
    assert.deepEqual(parseNodeDatabaseConfig({
        DATABASE_URL: 'postgresql://ims:secret@db.example.test:5432/ims',
        IMS_PG_POOL_MAX: '8',
        IMS_PG_IDLE_TIMEOUT_MS: '45000'
    }), {
        connectionString: 'postgresql://ims:secret@db.example.test:5432/ims',
        maxConnections: 8,
        idleTimeoutMs: 45_000,
        connectionTimeoutMs: 5_000,
        statementTimeoutMs: 30_000,
        idleInTransactionTimeoutMs: 30_000
    });
    assert.throws(
        () => parseNodeDatabaseConfig({
            DATABASE_URL: 'mysql://localhost/core'
        }),
        /valid PostgreSQL URL/
    );
    assert.throws(
        () => parseNodeDatabaseConfig({
            DATABASE_URL: 'postgresql://localhost'
        }),
        /valid PostgreSQL URL/
    );
    assert.throws(
        () => parseNodeDatabaseConfig({
            DATABASE_URL: 'postgresql://localhost/ims',
            IMS_PG_POOL_MAX: '101'
        }),
        /IMS_PG_POOL_MAX must be an integer between 1 and 100/
    );
});

test('FilesystemObjectStorage maps canonical business keys to owned roots', async (t) => {
    const root = await temporaryDirectory('ims-storage-roots-');
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const publicDir = path.join(root, 'public');
    const storyDataDir = path.join(root, 'story-data');
    const storage = new FilesystemObjectStorage({
        publicDir,
        storyDataDir,
        uploadsDir: path.join(root, 'uploads'),
        chronicleDir: path.join(root, 'chronicle')
    }, {
        publicReadUrlBase: 'https://media.example.test/content/'
    });
    const key = 'wiki/agencies/sc/idols/idol/story-images/card.webp';
    const body = new Uint8Array([1, 2, 3, 4]);

    await storage.put(key, body, { contentType: 'image/webp' });
    assert.deepEqual((await storage.get(key))?.body, body);
    assert.equal(
        await storage.createPublicReadUrl(key, {
            publicPath: '/image/SC/Mano/cards/card.webp'
        }),
        'https://media.example.test/content/image/SC/Mano/cards/card.webp'
    );
    assert.equal(
        await storage.createPublicReadUrl('wiki/agencies/sc/missing.webp', {
            publicPath: '/image/missing.webp'
        }),
        null
    );
    assert.deepEqual((await storage.list('wiki/agencies/sc')).map((entry) => entry.key), [key]);
    await assert.rejects(fs.lstat(path.join(publicDir, key)), { code: 'ENOENT' });
    assert.deepEqual(new Uint8Array(await fs.readFile(
        path.join(storyDataDir, 'agencies/sc/idols/idol/story-images/card.webp')
    )), body);
    await storage.delete(key);
    assert.equal(await storage.exists(key), false);

    const thumbnailKey = 'editorial/news/assets/legacy/thumbnail.jpg';
    await storage.put(thumbnailKey, new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        contentType: 'image/png'
    });
    assert.equal((await storage.get(thumbnailKey))?.contentType, 'image/png');
    await assert.rejects(fs.lstat(path.join(publicDir, thumbnailKey)), { code: 'ENOENT' });
    await assert.rejects(storage.put('Data/sc/idol/card.webp', body), /Unsupported object key namespace/);
});

test('NodeStaticAssets does not open a body for HEAD and opens only the requested byte range', async (t) => {
    const root = await temporaryDirectory('ims-static-range-');
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const filePath = path.join(root, 'runninggame/Build/game.data');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, Buffer.from('0123456789abcdef'));
    const opened: Array<{ start?: number; end?: number } | undefined> = [];
    const assets = new NodeStaticAssets(root, {
        lstat: (candidate) => fs.lstat(candidate),
        createReadStream(candidate, options) {
            opened.push(options);
            return createReadStream(candidate, options);
        }
    });

    const head = await assets.fetch(new Request('http://ims.test/runninggame/Build/game.data', {
        method: 'HEAD', headers: { Range: 'bytes=3-6' }
    }));
    assert.equal(head.status, 206);
    assert.equal(head.headers.get('content-length'), '4');
    assert.equal(head.headers.get('content-range'), 'bytes 3-6/16');
    assert.equal(head.headers.get('content-type'), 'application/octet-stream');
    assert.deepEqual(opened, []);

    const get = await assets.fetch(new Request('http://ims.test/runninggame/Build/game.data', {
        headers: { Range: 'bytes=3-6' }
    }));
    assert.equal(get.status, 206);
    assert.equal(await get.text(), '3456');
    assert.deepEqual(opened, [{ start: 3, end: 6 }]);

    const currentEtag = get.headers.get('etag');
    const lastModified = get.headers.get('last-modified');
    assert.ok(currentEtag);
    assert.ok(lastModified);
    const byEtag = await assets.fetch(new Request('http://ims.test/runninggame/Build/game.data', {
        headers: { 'If-None-Match': `W/${currentEtag}` }
    }));
    assert.equal(byEtag.status, 304);
    assert.equal(await byEtag.text(), '');
    const byDate = await assets.fetch(new Request('http://ims.test/runninggame/Build/game.data', {
        headers: { 'If-Modified-Since': lastModified }
    }));
    assert.equal(byDate.status, 304);
    assert.deepEqual(opened, [{ start: 3, end: 6 }]);

    const staleIfRange = await assets.fetch(new Request('http://ims.test/runninggame/Build/game.data', {
        headers: { Range: 'bytes=3-6', 'If-Range': '"stale"' }
    }));
    assert.equal(staleIfRange.status, 200);
    assert.equal(await staleIfRange.text(), '0123456789abcdef');
    const matchingIfRange = await assets.fetch(new Request('http://ims.test/runninggame/Build/game.data', {
        headers: { Range: 'bytes=3-6', 'If-Range': currentEtag }
    }));
    assert.equal(matchingIfRange.status, 206);
    assert.equal(await matchingIfRange.text(), '3456');
    assert.deepEqual(opened, [
        { start: 3, end: 6 },
        undefined,
        { start: 3, end: 6 }
    ]);

    const invalid = await assets.fetch(new Request('http://ims.test/runninggame/Build/game.data', {
        headers: { Range: 'bytes=99-100' }
    }));
    assert.equal(invalid.status, 416);
    assert.equal(invalid.headers.get('content-range'), 'bytes */16');
    assert.equal(opened.length, 3);
});

test('NodeStaticAssets negotiates precompressed assets without exposing encoded files', async (t) => {
    const root = await temporaryDirectory('ims-static-compression-');
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const assetPath = path.join(root, 'assets/app-abcdef12.js');
    const unhashedAssetPath = path.join(root, 'assets/runtime.js');
    const htmlPath = path.join(root, 'index.html');
    const source = Buffer.from('const message = "imsweb";\n'.repeat(200));
    const brotli = brotliCompressSync(source);
    const gzip = gzipSync(source);
    await fs.mkdir(path.dirname(assetPath), { recursive: true });
    await Promise.all([
        fs.writeFile(assetPath, source),
        fs.writeFile(`${assetPath}.br`, brotli),
        fs.writeFile(`${assetPath}.gz`, gzip),
        fs.writeFile(unhashedAssetPath, source),
        fs.writeFile(htmlPath, '<!doctype html><title>IMSWeb</title>')
    ]);
    const assets = new NodeStaticAssets(root);

    const brotliResponse = await assets.fetch(new Request('http://ims.test/assets/app-abcdef12.js', {
        headers: { 'Accept-Encoding': 'gzip;q=0.8, br' }
    }));
    assert.equal(brotliResponse.status, 200);
    assert.equal(brotliResponse.headers.get('content-encoding'), 'br');
    assert.equal(brotliResponse.headers.get('content-length'), String(brotli.byteLength));
    assert.equal(brotliResponse.headers.get('accept-ranges'), 'none');
    assert.equal(brotliResponse.headers.get('vary'), 'Accept-Encoding');
    assert.equal(
        brotliResponse.headers.get('cache-control'),
        'public, max-age=31536000, immutable'
    );
    assert.deepEqual(
        brotliDecompressSync(Buffer.from(await brotliResponse.arrayBuffer())),
        source
    );

    const gzipResponse = await assets.fetch(new Request('http://ims.test/assets/app-abcdef12.js', {
        headers: { 'Accept-Encoding': 'br;q=0, gzip' }
    }));
    assert.equal(gzipResponse.headers.get('content-encoding'), 'gzip');
    assert.deepEqual(gunzipSync(Buffer.from(await gzipResponse.arrayBuffer())), source);

    const head = await assets.fetch(new Request('http://ims.test/assets/app-abcdef12.js', {
        method: 'HEAD',
        headers: { 'Accept-Encoding': 'br' }
    }));
    assert.equal(head.headers.get('content-encoding'), 'br');
    assert.equal(head.headers.get('content-length'), String(brotli.byteLength));
    assert.equal(await head.text(), '');

    const range = await assets.fetch(new Request('http://ims.test/assets/app-abcdef12.js', {
        headers: {
            'Accept-Encoding': 'br',
            Range: 'bytes=0-4'
        }
    }));
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('content-encoding'), null);
    assert.equal(range.headers.get('content-range'), `bytes 0-4/${source.byteLength}`);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), source.subarray(0, 5));

    const html = await assets.fetch(new Request('http://ims.test/index.html'));
    assert.equal(html.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
    const unhashed = await assets.fetch(new Request('http://ims.test/assets/runtime.js'));
    assert.equal(unhashed.headers.get('cache-control'), null);
    const frontendFiles = listFrontendFiles(root).sort();
    assert.deepEqual(frontendFiles, [
        'assets/app-abcdef12.js',
        'assets/runtime.js',
        'index.html'
    ]);
    const frontend = new FrontendStaticAssets(assets, new Set(frontendFiles));
    const encodedPath = await frontend.fetch(
        new Request('http://ims.test/assets/app-abcdef12.js.br')
    );
    assert.equal(encodedPath.status, 404);
});

test('filesystem idempotency persists replay, rejects fingerprint reuse, and recovers failure', async (t) => {
    const root = await temporaryDirectory('ims-idempotency-');
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const first = new FilesystemIdempotencyStore(root);
    const firstClaim = await first.claim('scope', 'key', 'fingerprint');
    assert.deepEqual(firstClaim, { kind: 'acquired', recovered: false, generation: 1 });
    if (firstClaim.kind !== 'acquired') return;
    assert.deepEqual(await first.claim('scope', 'key', 'fingerprint'), { kind: 'in-progress' });
    await first.complete(
        'scope', 'key', 'fingerprint', firstClaim.generation,
        { status: 201, body: { ok: true } }
    );

    const restarted = new FilesystemIdempotencyStore(root);
    assert.deepEqual(await restarted.claim('scope', 'key', 'fingerprint'), {
        kind: 'replay', response: { status: 201, body: { ok: true } }
    });
    assert.deepEqual(await restarted.claim('scope', 'key', 'different'), { kind: 'conflict' });
    const retry = await restarted.claim('scope', 'retry', 'same');
    assert.deepEqual(retry, { kind: 'acquired', recovered: false, generation: 1 });
    if (retry.kind !== 'acquired') return;
    await restarted.fail('scope', 'retry', 'same', retry.generation);
    assert.deepEqual(await restarted.claim('scope', 'retry', 'same'), {
        kind: 'acquired', recovered: true, generation: 2
    });
});

test('filesystem compensation journal retries a failed idempotent delete to completion', async (t) => {
    const root = await temporaryDirectory('ims-compensation-');
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    let attempts = 0;
    const storage = {
        async delete() {
            attempts += 1;
            if (attempts === 1) throw new Error('temporary delete failure');
        }
    } as unknown as ObjectStorage;
    const service = new FilesystemCompensationService(root);
    const id = await service.enqueue('delete-object', { key: 'uploads/event/original/a.png' });
    await service.run(storage);
    let entry = JSON.parse(await fs.readFile(path.join(root, `${id}.json`), 'utf8'));
    assert.equal(entry.state, 'failed');
    assert.equal(entry.attempts, 1);
    await service.run(storage);
    await service.run(storage);
    entry = JSON.parse(await fs.readFile(path.join(root, `${id}.json`), 'utf8'));
    assert.equal(entry.state, 'completed');
    assert.equal(entry.attempts, 2);
    assert.equal(attempts, 2);
});
