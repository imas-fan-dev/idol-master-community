'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_SOURCE_ORIGIN = 'https://idol-master.top';
const DEFAULT_PAGE_CONCURRENCY = 4;
const DEFAULT_ASSET_CONCURRENCY = 4;
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const WIKI_STATIC_PREFIX = 'wiki/shared/static';
const WIKI_MANIFEST_KEY = 'system/migrations/wiki/idol-master-top-latest.json';
const ASSET_PATH_PREFIXES = ['/image/', '/icon/', '/css/', '/assets/'];
const USER_AGENT = 'IMSWeb-Wiki-Media-Sync/1.0 (+https://idol-master.top/)';

function sha256(body) {
    return crypto.createHash('sha256').update(body).digest('hex');
}

function compareUtf8(left, right) {
    return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function normalizeOrigin(value) {
    const url = new URL(value || DEFAULT_SOURCE_ORIGIN);
    if (url.username || url.password || url.search || url.hash) {
        throw new Error('Source origin must not contain credentials, query, or fragment');
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('Source origin must use HTTP or HTTPS');
    }
    return url.origin;
}

function positiveInteger(value, name, fallback) {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 32) {
        throw new Error(`${name} must be an integer between 1 and 32`);
    }
    return parsed;
}

function parseArguments(argv, environment = process.env) {
    const projectRoot = path.resolve(__dirname, '../../../..');
    const options = {
        sourceOrigin: DEFAULT_SOURCE_ORIGIN,
        stagingDir: path.join(projectRoot, 'data/migration/wiki-import'),
        manifest: undefined,
        pageConcurrency: DEFAULT_PAGE_CONCURRENCY,
        assetConcurrency: DEFAULT_ASSET_CONCURRENCY,
        upload: false,
        uploadExisting: false,
        help: false
    };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--') continue;
        const next = () => {
            const value = argv[++index];
            if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
            return value;
        };
        if (argument === '--source-origin') options.sourceOrigin = next();
        else if (argument === '--staging-dir') options.stagingDir = next();
        else if (argument === '--manifest') options.manifest = next();
        else if (argument === '--page-concurrency') options.pageConcurrency = next();
        else if (argument === '--asset-concurrency') options.assetConcurrency = next();
        else if (argument === '--upload') options.upload = true;
        else if (argument === '--upload-existing') {
            options.upload = true;
            options.uploadExisting = true;
        }
        else if (argument === '--help' || argument === '-h') options.help = true;
        else throw new Error(`Unknown argument: ${argument}`);
    }
    options.sourceOrigin = normalizeOrigin(options.sourceOrigin);
    options.stagingDir = path.resolve(options.stagingDir);
    options.manifest = path.resolve(options.manifest || path.join(options.stagingDir, 'manifest.json'));
    options.pageConcurrency = positiveInteger(
        options.pageConcurrency,
        '--page-concurrency',
        DEFAULT_PAGE_CONCURRENCY
    );
    options.assetConcurrency = positiveInteger(
        options.assetConcurrency,
        '--asset-concurrency',
        DEFAULT_ASSET_CONCURRENCY
    );
    return options;
}

function helpText() {
    return [
        'Usage: pnpm --filter @imsweb/api run migration:wiki-media -- [options]',
        '',
        'Options:',
        '  --source-origin <url>       Wiki origin (default: https://idol-master.top)',
        '  --staging-dir <path>        Local page and asset staging directory',
        '  --manifest <path>           Output manifest path',
        '  --page-concurrency <n>      Concurrent story page requests (default: 4)',
        '  --asset-concurrency <n>     Concurrent asset requests/uploads (default: 4)',
        '  --upload                    Upload verified assets and manifest to configured S3',
        '  --upload-existing           Verify staging manifest/files and upload without recrawling',
        '  --help                      Show this help',
        '',
        'Upload requires IMS_OBJECT_STORAGE=s3, IMS_S3_BUCKET, IMS_S3_REGION,',
        'IMS_S3_ENDPOINT/IMS_S3_FORCE_PATH_STYLE when needed, and AWS credentials.'
    ].join('\n');
}

function loadIdolRowsFromPostgres(storyRepository) {
    return storyRepository.listIdolsWithAgencies().then((rows) =>
        rows.map((row) => ({
            agency_code: row.agency_code,
            agency_name: row.agency_name,
            idol_name: row.name_cn,
            folder_name: row.folder_name
        }))
    );
}

async function createPostgresStoryRepository(
    environment = process.env,
    dependencies = {}
) {
    const {
        parseNodeDatabaseConfig,
        PostgresConnection,
        PostgresqlSchemaStrategy,
        SqlStoryRepository
    } = dependencies.modules || {
        parseNodeDatabaseConfig: require('../../src/config/database.ts').parseNodeDatabaseConfig,
        PostgresConnection: require('../../src/infra/db/postgresql/connection.ts').PostgresConnection,
        PostgresqlSchemaStrategy:
            require('../../src/infra/db/postgresql/schema-strategy.ts').PostgresqlSchemaStrategy,
        SqlStoryRepository:
            require('../../src/infra/db/repositories/story-repository.ts').SqlStoryRepository
    };
    const config = parseNodeDatabaseConfig(environment, { path: '' });
    if (config.type !== 'postgresql') {
        throw new Error('Wiki media sync requires IMS_DATABASE=postgresql');
    }

    const database = PostgresConnection.create(config);
    const repository = new SqlStoryRepository(
        database,
        new PostgresqlSchemaStrategy()
    );
    try {
        await repository.initialize();
        return repository;
    } catch (error) {
        await repository.close();
        throw error;
    }
}

function buildIdolIndex(rows) {
    const index = new Map();
    for (const row of rows) {
        const values = [row.agency_code, row.agency_name, row.idol_name, row.folder_name];
        if (values.some((value) => typeof value !== 'string' || !value.trim())) {
            throw new Error('Story database contains an incomplete agency/idol mapping');
        }
        const key = `${row.agency_name.normalize('NFC')}\0${row.idol_name.normalize('NFC')}`;
        if (index.has(key)) throw new Error(`Duplicate agency/idol mapping: ${key.replace('\0', '/')}`);
        index.set(key, {
            agencyCode: row.agency_code,
            agencyName: row.agency_name.normalize('NFC'),
            idolName: row.idol_name.normalize('NFC'),
            folderName: row.folder_name.normalize('NFC')
        });
    }
    return index;
}

function safeSegment(value) {
    const segment = decodeURIComponent(value).normalize('NFC');
    if (
        !segment || segment === '.' || segment === '..' ||
        /[\\/\0-\x1f\x7f]/.test(segment)
    ) throw new Error(`Unsafe URL path segment: ${value}`);
    return segment;
}

function decodedSegments(url) {
    return new URL(url).pathname.split('/').filter(Boolean).map(safeSegment);
}

function safeObjectKey(segments) {
    if (!segments.length) throw new Error('Object key cannot be empty');
    for (const segment of segments) {
        if (!segment || segment === '.' || segment === '..' || /[\\/\0-\x1f\x7f]/.test(segment)) {
            throw new Error(`Unsafe object-key segment: ${segment}`);
        }
    }
    const key = segments.join('/').normalize('NFC');
    if (Buffer.byteLength(key, 'utf8') > 1024) throw new Error(`Object key is too long: ${key}`);
    return key;
}

function mapAssetUrl(assetUrl, idolIndex) {
    const segments = decodedSegments(assetUrl);
    if (segments[0] === 'image') {
        if (segments.length < 4) throw new Error(`Incomplete Wiki image path: ${assetUrl}`);
        const agencyName = segments[1];
        const idolName = segments[2];
        const idol = idolIndex.get(`${agencyName}\0${idolName}`);
        if (!idol) throw new Error(`Wiki image has no local agency/idol mapping: ${agencyName}/${idolName}`);
        const relativeSegments = segments.slice(3);
        const avatar = relativeSegments.length === 1 &&
            /^icon\.(?:avif|bmp|gif|jpe?g|png|webp)$/i.test(relativeSegments[0]);
        const extension = path.posix.extname(relativeSegments[0]).toLowerCase();
        return {
            kind: 'story-media',
            agencyCode: idol.agencyCode,
            agencyName,
            idolName,
            folderName: idol.folderName,
            relativePath: relativeSegments.join('/'),
            objectKey: avatar
                ? safeObjectKey([
                    'wiki', 'agencies', idol.agencyCode, 'idols', idol.folderName,
                    `avatar${extension}`
                ])
                : safeObjectKey([
                    'wiki', 'agencies', idol.agencyCode, 'idols', idol.folderName,
                    'story-images', ...relativeSegments
                ])
        };
    }
    if (['icon', 'css', 'assets'].includes(segments[0])) {
        const agencyIcon = segments[0] === 'icon' && segments[1] === 'agencies' &&
            segments.length === 3 && /^[a-z0-9_-]+\.webp$/i.test(segments[2]);
        const agencyCode = agencyIcon ? segments[2].slice(0, -'.webp'.length) : null;
        return {
            kind: 'wiki-static',
            relativePath: segments.join('/'),
            objectKey: agencyCode
                ? safeObjectKey(['wiki', 'agencies', agencyCode, 'branding', 'icon.webp'])
                : safeObjectKey(['wiki', 'shared', 'static', ...segments])
        };
    }
    throw new Error(`Unsupported first-party Wiki asset path: ${assetUrl}`);
}

function canonicalAssetUrl(value, baseUrl, sourceOrigin) {
    if (typeof value !== 'string' || !value.trim() || value.startsWith('data:')) return null;
    let resolved;
    try {
        resolved = new URL(value.trim(), baseUrl);
    } catch {
        return null;
    }
    if (resolved.origin !== sourceOrigin) return null;
    if (!ASSET_PATH_PREFIXES.some((prefix) => resolved.pathname.startsWith(prefix))) return null;
    resolved.hash = '';
    resolved.search = '';
    return resolved.href;
}

function canonicalStoryUrl(value, baseUrl, sourceOrigin) {
    let resolved;
    try {
        resolved = new URL(value, baseUrl);
    } catch {
        return null;
    }
    if (resolved.origin !== sourceOrigin || resolved.pathname !== '/story') return null;
    const agency = resolved.searchParams.get('agency')?.normalize('NFC');
    const idol = resolved.searchParams.get('idol')?.normalize('NFC');
    if (!agency || !idol) return null;
    const canonical = new URL('/story', sourceOrigin);
    canonical.searchParams.set('agency', agency);
    canonical.searchParams.set('idol', idol);
    return { url: canonical.href, agency, idol };
}

function extractCssReferences(css, baseUrl, sourceOrigin) {
    const references = new Set();
    const patterns = [
        /url\(\s*(['"]?)(.*?)\1\s*\)/gisu,
        /@import\s+(?:url\(\s*)?['"]([^'"]+)['"]/gisu
    ];
    for (const pattern of patterns) {
        for (const match of css.matchAll(pattern)) {
            const candidate = canonicalAssetUrl(match[2] || match[1], baseUrl, sourceOrigin);
            if (candidate) references.add(candidate);
        }
    }
    return references;
}

function assignedJson(script, assignment) {
    const marker = script.indexOf(assignment);
    if (marker < 0) return null;
    const equals = script.indexOf('=', marker + assignment.length);
    if (equals < 0) return null;
    let start = equals + 1;
    while (/\s/.test(script[start] || '')) start += 1;
    const opener = script[start];
    if (opener !== '[' && opener !== '{') return null;
    const closer = opener === '[' ? ']' : '}';
    let depth = 0;
    let string = false;
    let escaped = false;
    for (let index = start; index < script.length; index += 1) {
        const character = script[index];
        if (string) {
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === '"') string = false;
            continue;
        }
        if (character === '"') string = true;
        else if (character === opener) depth += 1;
        else if (character === closer) {
            depth -= 1;
            if (depth === 0) return JSON.parse(script.slice(start, index + 1));
        }
    }
    throw new Error(`Unterminated ${assignment} JSON assignment`);
}

function collectJsonAssetStrings(value, baseUrl, sourceOrigin, references) {
    if (typeof value === 'string') {
        const candidate = canonicalAssetUrl(value, baseUrl, sourceOrigin);
        if (candidate) references.add(candidate);
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectJsonAssetStrings(item, baseUrl, sourceOrigin, references);
        return;
    }
    if (value && typeof value === 'object') {
        for (const item of Object.values(value)) {
            collectJsonAssetStrings(item, baseUrl, sourceOrigin, references);
        }
    }
}

function extractHtmlReferences(html, baseUrl, sourceOrigin, parse) {
    const document = parse(html);
    const assets = new Set();
    const stories = new Map();

    function addAsset(value) {
        const candidate = canonicalAssetUrl(value, baseUrl, sourceOrigin);
        if (candidate) assets.add(candidate);
    }

    function visit(node) {
        for (const attribute of node.attrs || []) {
            if (['src', 'href', 'poster'].includes(attribute.name)) {
                addAsset(attribute.value);
                const story = canonicalStoryUrl(attribute.value, baseUrl, sourceOrigin);
                if (story) stories.set(story.url, story);
            } else if (attribute.name === 'style') {
                for (const asset of extractCssReferences(attribute.value, baseUrl, sourceOrigin)) {
                    assets.add(asset);
                }
            }
        }
        if (node.tagName === 'style') {
            const css = (node.childNodes || []).map((child) => child.value || '').join('');
            for (const asset of extractCssReferences(css, baseUrl, sourceOrigin)) assets.add(asset);
        }
        if (node.tagName === 'script') {
            const script = (node.childNodes || []).map((child) => child.value || '').join('');
            const storyData = assignedJson(script, 'window.storyData');
            if (storyData) collectJsonAssetStrings(storyData, baseUrl, sourceOrigin, assets);
        }
        for (const child of node.childNodes || []) visit(child);
        if (node.content) visit(node.content);
    }
    visit(document);
    return { assets, stories };
}

function detectedContentType(body) {
    if (body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return 'image/png';
    }
    if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return 'image/jpeg';
    if (body.subarray(0, 6).toString('ascii').startsWith('GIF8')) return 'image/gif';
    if (body.subarray(0, 4).toString('ascii') === 'RIFF' && body.subarray(8, 12).toString('ascii') === 'WEBP') {
        return 'image/webp';
    }
    if (body.length >= 12 && body.subarray(4, 8).toString('ascii') === 'ftyp') {
        const brand = body.subarray(8, 12).toString('ascii');
        if (['avif', 'avis'].includes(brand)) return 'image/avif';
    }
    if (body.subarray(0, 4).toString('ascii') === 'wOFF') return 'font/woff';
    if (body.subarray(0, 4).toString('ascii') === 'wOF2') return 'font/woff2';
    if (body.subarray(0, 4).toString('hex') === '00010000') return 'font/ttf';
    const prefix = body.subarray(0, Math.min(body.length, 512)).toString('utf8').trimStart();
    if (/^<svg[\s>]/i.test(prefix) || /^<\?xml[\s\S]*?<svg[\s>]/i.test(prefix)) return 'image/svg+xml';
    return null;
}

function resolvedContentType(sourceUrl, header, body) {
    const pathname = new URL(sourceUrl).pathname.toLowerCase();
    if (pathname.endsWith('.css')) return 'text/css; charset=utf-8';
    const detected = detectedContentType(body);
    const extension = path.posix.extname(pathname);
    if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg'].includes(extension)) {
        if (!detected?.startsWith('image/')) throw new Error(`Asset content is not an image: ${sourceUrl}`);
        return detected;
    }
    return detected || String(header || 'application/octet-stream').split(';', 1)[0].trim().toLowerCase();
}

async function fetchBody(url, { maxBytes, accept, sourceOrigin, attempts = 3 } = {}) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            const response = await fetch(url, {
                redirect: 'follow',
                signal: AbortSignal.timeout(45_000),
                headers: { 'User-Agent': USER_AGENT, Accept: accept || '*/*' }
            });
            if (new URL(response.url).origin !== sourceOrigin) {
                throw new Error(`Cross-origin redirect rejected: ${url} -> ${response.url}`);
            }
            if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
            const declared = Number(response.headers.get('content-length') || '0');
            if (declared && declared > maxBytes) throw new Error(`Response exceeds byte limit: ${url}`);
            const body = Buffer.from(await response.arrayBuffer());
            if (body.byteLength > maxBytes) throw new Error(`Response exceeds byte limit: ${url}`);
            return { body, headers: response.headers, finalUrl: response.url };
        } catch (error) {
            lastError = error;
            if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
        }
    }
    throw lastError;
}

async function mapConcurrent(items, concurrency, worker) {
    const results = new Array(items.length);
    let cursor = 0;
    async function consume() {
        while (cursor < items.length) {
            const index = cursor++;
            results[index] = await worker(items[index], index);
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, consume));
    return results;
}

async function writeStagedFile(root, relativePath, body) {
    const destination = path.resolve(root, relativePath);
    const relative = path.relative(root, destination);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Unsafe staging path: ${relativePath}`);
    }
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.writeFile(destination, body);
    return relative.split(path.sep).join('/');
}

function storyIdentity(story, idolIndex) {
    const idol = idolIndex.get(`${story.agency}\0${story.idol}`);
    if (!idol) return null;
    return { ...idol, sourceUrl: story.url };
}

async function objectStorage(environment = process.env) {
    if (environment.IMS_OBJECT_STORAGE?.trim().toLowerCase() !== 's3') {
        throw new Error('--upload requires IMS_OBJECT_STORAGE=s3');
    }
    const { resolveNodeServices } = require('../../src/runtime/node-services.ts');
    return (await resolveNodeServices()).storage;
}

async function uploadAsset(storage, stagingDir, asset) {
    const current = await storage.get(asset.objectKey);
    if (
        current && current.size === asset.bytes &&
        sha256(current.body) === asset.sha256
    ) {
        return { status: 'unchanged', etag: current.etag || null };
    }
    const body = await fsp.readFile(path.join(stagingDir, asset.stagedPath));
    const result = await storage.put(asset.objectKey, body, {
        contentType: asset.contentType,
        sha256: asset.sha256,
        metadata: {
            sha256: asset.sha256,
            source: encodeURIComponent(asset.sourcePath)
        }
    });
    const verified = await storage.get(asset.objectKey);
    if (!verified || verified.size !== asset.bytes || sha256(verified.body) !== asset.sha256) {
        throw new Error(`Uploaded object verification failed: ${asset.objectKey}`);
    }
    return { status: current ? 'replaced' : 'uploaded', etag: result.etag || verified.etag || null };
}

async function writeManifest(file, manifest) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function uploadManifestDocument(storage, sourceOrigin, manifest) {
    const body = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await storage.put(WIKI_MANIFEST_KEY, body, {
        contentType: 'application/json; charset=utf-8',
        sha256: sha256(body),
        metadata: { source: encodeURIComponent(`${sourceOrigin}/wiki/`) }
    });
}

async function uploadExistingManifest(options, idolIndex, providedStorage) {
    const parsed = JSON.parse(await fsp.readFile(options.manifest, 'utf8'));
    if (parsed.version !== 1 || parsed.complete !== true || !Array.isArray(parsed.assets)) {
        throw new Error('Existing Wiki manifest must be a complete version 1 document');
    }
    if (normalizeOrigin(parsed.sourceOrigin) !== options.sourceOrigin) {
        throw new Error('Existing Wiki manifest source origin does not match --source-origin');
    }
    if (parsed.errors?.length) throw new Error('Existing Wiki manifest contains errors');
    const objectKeys = new Set();
    await mapConcurrent(parsed.assets, options.assetConcurrency, async (asset) => {
        if (
            !asset || typeof asset !== 'object' || typeof asset.sourceUrl !== 'string' ||
            typeof asset.objectKey !== 'string' || typeof asset.stagedPath !== 'string' ||
            typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256) ||
            !Number.isSafeInteger(asset.bytes) || asset.bytes < 0 ||
            typeof asset.contentType !== 'string' || !asset.contentType
        ) throw new Error('Existing Wiki manifest contains an invalid asset entry');
        if (objectKeys.has(asset.objectKey)) throw new Error(`Duplicate manifest object key: ${asset.objectKey}`);
        objectKeys.add(asset.objectKey);
        const remapped = mapAssetUrl(asset.sourceUrl, idolIndex);
        if (remapped.objectKey !== asset.objectKey) {
            throw new Error(`Manifest business mapping changed: ${asset.objectKey}`);
        }
        const stagedFile = path.resolve(options.stagingDir, asset.stagedPath);
        const relative = path.relative(options.stagingDir, stagedFile);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new Error(`Unsafe manifest staging path: ${asset.stagedPath}`);
        }
        const body = await fsp.readFile(stagedFile);
        if (body.byteLength !== asset.bytes || sha256(body) !== asset.sha256) {
            throw new Error(`Staged Wiki asset failed integrity verification: ${asset.objectKey}`);
        }
    });

    const storage = providedStorage || await objectStorage();
    const results = await mapConcurrent(parsed.assets, options.assetConcurrency, async (asset) => {
        const result = await uploadAsset(storage, options.stagingDir, asset);
        asset.upload = result;
        return result;
    });
    parsed.uploadedAt = new Date().toISOString();
    parsed.summary = {
        ...parsed.summary,
        uploaded: results.filter((result) =>
            result.status === 'uploaded' || result.status === 'replaced').length,
        unchanged: results.filter((result) => result.status === 'unchanged').length
    };
    await writeManifest(options.manifest, parsed);
    await uploadManifestDocument(storage, options.sourceOrigin, parsed);
    return parsed;
}

async function syncWikiMedia(options, idolIndex, providedStorage) {
    const { parse } = await import('parse5');
    await fsp.mkdir(options.stagingDir, { recursive: true });

    const manifest = {
        version: 1,
        sourceOrigin: options.sourceOrigin,
        generatedAt: new Date().toISOString(),
        databaseIdolCount: idolIndex.size,
        complete: false,
        pages: [],
        assets: [],
        errors: [],
        summary: {}
    };

    const indexUrl = `${options.sourceOrigin}/wiki/`;
    const indexResponse = await fetchBody(indexUrl, {
        maxBytes: MAX_PAGE_BYTES,
        accept: 'text/html',
        sourceOrigin: options.sourceOrigin
    });
    const indexHtml = indexResponse.body.toString('utf8');
    const indexReferences = extractHtmlReferences(indexHtml, indexUrl, options.sourceOrigin, parse);
    const indexPath = await writeStagedFile(options.stagingDir, 'pages/wiki/index.html', indexResponse.body);
    manifest.pages.push({
        type: 'index',
        sourceUrl: indexUrl,
        stagedPath: indexPath,
        bytes: indexResponse.body.byteLength,
        sha256: sha256(indexResponse.body),
        assets: [...indexReferences.assets].sort(compareUtf8)
    });

    const remoteStories = [...indexReferences.stories.values()].sort((left, right) => compareUtf8(left.url, right.url));
    const remoteIdentities = new Set(remoteStories.map((story) => `${story.agency}\0${story.idol}`));
    const databaseIdentities = new Set(idolIndex.keys());
    for (const identity of remoteIdentities) {
        if (!databaseIdentities.has(identity)) {
            manifest.errors.push({ type: 'unknown-remote-story', identity: identity.replace('\0', '/') });
        }
    }
    for (const identity of databaseIdentities) {
        if (!remoteIdentities.has(identity)) {
            manifest.errors.push({ type: 'missing-remote-story', identity: identity.replace('\0', '/') });
        }
    }
    if (manifest.errors.length) {
        manifest.summary = {
            pageCount: manifest.pages.length,
            remoteStoryCount: remoteStories.length,
            databaseIdolCount: idolIndex.size,
            assetCount: 0,
            errorCount: manifest.errors.length
        };
        await writeManifest(options.manifest, manifest);
        throw new Error(`Remote/local Wiki story inventory differs (${manifest.errors.length} mismatch(es))`);
    }

    const contextsByAsset = new Map();
    function addAsset(sourceUrl, context) {
        const contexts = contextsByAsset.get(sourceUrl) || new Set();
        contexts.add(context);
        contextsByAsset.set(sourceUrl, contexts);
    }
    for (const sourceUrl of indexReferences.assets) addAsset(sourceUrl, 'page:wiki/index');

    const storyResults = await mapConcurrent(remoteStories, options.pageConcurrency, async (story) => {
        const identity = storyIdentity(story, idolIndex);
        try {
            const response = await fetchBody(story.url, {
                maxBytes: MAX_PAGE_BYTES,
                accept: 'text/html',
                sourceOrigin: options.sourceOrigin
            });
            const html = response.body.toString('utf8');
            const references = extractHtmlReferences(html, story.url, options.sourceOrigin, parse);
            const pageId = `${identity.agencyCode}/${identity.folderName}`;
            for (const sourceUrl of references.assets) addAsset(sourceUrl, `page:story/${pageId}`);
            const stagedPath = await writeStagedFile(
                options.stagingDir,
                `pages/story/${identity.agencyCode}/${identity.folderName}.html`,
                response.body
            );
            return {
                type: 'story',
                sourceUrl: story.url,
                agencyCode: identity.agencyCode,
                agencyName: identity.agencyName,
                idolName: identity.idolName,
                folderName: identity.folderName,
                stagedPath,
                bytes: response.body.byteLength,
                sha256: sha256(response.body),
                assets: [...references.assets].sort(compareUtf8)
            };
        } catch (error) {
            manifest.errors.push({ type: 'page-download', sourceUrl: story.url, message: error.message });
            return null;
        }
    });
    manifest.pages.push(...storyResults.filter(Boolean));

    const assetsByUrl = new Map();
    const objectSources = new Map();
    while (true) {
        const pending = [...contextsByAsset.keys()].filter((sourceUrl) => !assetsByUrl.has(sourceUrl));
        if (!pending.length) break;
        pending.sort(compareUtf8);
        await mapConcurrent(pending, options.assetConcurrency, async (sourceUrl) => {
            try {
                const mapping = mapAssetUrl(sourceUrl, idolIndex);
                const previousSource = objectSources.get(mapping.objectKey);
                if (previousSource && previousSource !== sourceUrl) {
                    throw new Error(`Object-key collision with ${previousSource}`);
                }
                objectSources.set(mapping.objectKey, sourceUrl);
                const response = await fetchBody(sourceUrl, {
                    maxBytes: MAX_ASSET_BYTES,
                    accept: '*/*',
                    sourceOrigin: options.sourceOrigin
                });
                const contentType = resolvedContentType(
                    sourceUrl,
                    response.headers.get('content-type'),
                    response.body
                );
                const stagedPath = await writeStagedFile(
                    options.stagingDir,
                    `objects/${mapping.objectKey}`,
                    response.body
                );
                const asset = {
                    sourceUrl,
                    sourcePath: decodeURIComponent(new URL(sourceUrl).pathname).normalize('NFC'),
                    ...mapping,
                    contexts: [...contextsByAsset.get(sourceUrl)].sort(compareUtf8),
                    stagedPath,
                    bytes: response.body.byteLength,
                    contentType,
                    sha256: sha256(response.body)
                };
                assetsByUrl.set(sourceUrl, asset);
                if (contentType.startsWith('text/css')) {
                    const css = response.body.toString('utf8');
                    for (const reference of extractCssReferences(css, sourceUrl, options.sourceOrigin)) {
                        addAsset(reference, `css:${mapping.relativePath}`);
                    }
                }
            } catch (error) {
                assetsByUrl.set(sourceUrl, null);
                manifest.errors.push({ type: 'asset-download', sourceUrl, message: error.message });
            }
        });
    }

    manifest.assets = [...assetsByUrl.values()].filter(Boolean)
        .sort((left, right) => compareUtf8(left.objectKey, right.objectKey));
    manifest.pages.sort((left, right) => compareUtf8(left.sourceUrl, right.sourceUrl));
    manifest.errors.sort((left, right) => compareUtf8(
        `${left.sourceUrl || ''}:${left.identity || ''}`,
        `${right.sourceUrl || ''}:${right.identity || ''}`
    ));

    let storage = providedStorage;
    if (!manifest.errors.length && options.upload) {
        storage ||= await objectStorage();
        const uploadResults = await mapConcurrent(
            manifest.assets,
            options.assetConcurrency,
            async (asset) => {
                try {
                    const result = await uploadAsset(storage, options.stagingDir, asset);
                    asset.upload = result;
                    return result;
                } catch (error) {
                    manifest.errors.push({
                        type: 'asset-upload',
                        sourceUrl: asset.sourceUrl,
                        objectKey: asset.objectKey,
                        message: error.message
                    });
                    return null;
                }
            }
        );
        const uploaded = uploadResults.filter((result) =>
            result?.status === 'uploaded' || result?.status === 'replaced').length;
        const unchanged = uploadResults.filter((result) => result?.status === 'unchanged').length;
        manifest.summary.uploaded = uploaded;
        manifest.summary.unchanged = unchanged;
    }

    manifest.complete = manifest.errors.length === 0;
    manifest.summary = {
        ...manifest.summary,
        pageCount: manifest.pages.length,
        storyPageCount: manifest.pages.filter((page) => page.type === 'story').length,
        remoteStoryCount: remoteStories.length,
        databaseIdolCount: idolIndex.size,
        assetCount: manifest.assets.length,
        storyMediaCount: manifest.assets.filter((asset) => asset.kind === 'story-media').length,
        staticAssetCount: manifest.assets.filter((asset) => asset.kind === 'wiki-static').length,
        totalAssetBytes: manifest.assets.reduce((total, asset) => total + asset.bytes, 0),
        errorCount: manifest.errors.length
    };
    await writeManifest(options.manifest, manifest);

    if (manifest.errors.length) {
        throw new Error(`Wiki media sync has ${manifest.errors.length} error(s); see ${options.manifest}`);
    }

    if (options.upload) {
        storage ||= await objectStorage();
        await uploadManifestDocument(storage, options.sourceOrigin, manifest);
    }
    return manifest;
}

async function closeObjectStorageServices() {
    const { closeNodeServices } = require('../../src/runtime/node-services.ts');
    await closeNodeServices();
}

async function runWikiMediaSync(options, dependencies = {}) {
    const openStoryRepository = dependencies.openStoryRepository ||
        createPostgresStoryRepository;
    const resolveStorage = dependencies.resolveStorage || objectStorage;
    const closeStorage = dependencies.closeStorage || closeObjectStorageServices;
    const crawl = dependencies.syncWikiMedia || syncWikiMedia;
    const uploadExisting = dependencies.uploadExistingManifest || uploadExistingManifest;
    let storyRepository;

    try {
        storyRepository = await openStoryRepository();
        const idolIndex = buildIdolIndex(
            await loadIdolRowsFromPostgres(storyRepository)
        );
        const storage = options.upload ? await resolveStorage() : undefined;
        return options.uploadExisting
            ? await uploadExisting(options, idolIndex, storage)
            : await crawl(options, idolIndex, storage);
    } finally {
        try {
            await storyRepository?.close();
        } finally {
            if (options.upload) await closeStorage();
        }
    }
}

async function main() {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
        process.stdout.write(`${helpText()}\n`);
        return;
    }

    require('../../src/config/load-environment.ts');
    const manifest = await runWikiMediaSync(options);
    process.stdout.write(`${JSON.stringify({
        manifest: options.manifest,
        complete: manifest.complete,
        ...manifest.summary
    }, null, 2)}\n`);
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    });
}

module.exports = {
    WIKI_MANIFEST_KEY,
    WIKI_STATIC_PREFIX,
    assignedJson,
    buildIdolIndex,
    canonicalAssetUrl,
    canonicalStoryUrl,
    createPostgresStoryRepository,
    extractCssReferences,
    extractHtmlReferences,
    mapAssetUrl,
    parseArguments,
    resolvedContentType,
    runWikiMediaSync,
    safeObjectKey,
    syncWikiMedia,
    uploadExistingManifest
};
