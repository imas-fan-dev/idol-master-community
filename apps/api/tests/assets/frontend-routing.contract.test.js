'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const REPOSITORY_ROOT = path.resolve(PROJECT_ROOT, '../..');
const FRONTEND_ROOT = path.join(REPOSITORY_ROOT, 'apps/web/build/client');
const SERVER_ROOT = path.join(PROJECT_ROOT, 'dist/server');

function requireBuild(file, command) {
    assert.ok(
        fs.existsSync(file),
        `Required build output is missing: ${file}\nRun ${command} from ${REPOSITORY_ROOT}`
    );
}

requireBuild(
    path.join(FRONTEND_ROOT, '__spa-fallback.html'),
    'pnpm --filter @imsweb/web run build'
);
requireBuild(
    path.join(SERVER_ROOT, 'app.js'),
    'pnpm --filter @imsweb/api run build'
);

const { createHonoApp } = require(path.join(SERVER_ROOT, 'app.js'));
const { FrontendStaticAssets, NodeStaticAssets } = require(path.join(
    SERVER_ROOT,
    'infra/http/filesystem/static-assets.js'
));
const { resolveFrontendRoute } = require(path.join(
    SERVER_ROOT,
    'routing/frontend-route-policy.js'
));

function walkFiles(directory, root = directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const absolute = path.join(directory, entry.name);
        assert.equal(entry.isSymbolicLink(), false, `build/client contains a symlink: ${absolute}`);
        if (entry.isDirectory()) return walkFiles(absolute, root);
        assert.equal(entry.isFile(), true, `build/client contains a non-file: ${absolute}`);
        return [path.relative(root, absolute).split(path.sep).join('/')];
    });
}

const frontendFileList = walkFiles(FRONTEND_ROOT).sort();
const frontendFiles = new Set(frontendFileList);
const app = createHonoApp(() => ({
    staticAssets: new FrontendStaticAssets(
        new NodeStaticAssets(FRONTEND_ROOT),
        frontendFiles
    )
}));

async function request(pathname, init) {
    return app.request(`http://ims.test${pathname}`, init);
}

async function assertFileResponse(pathname, file, init) {
    const response = await request(pathname, init);
    assert.equal(response.status, 200, pathname);
    assert.deepEqual(
        Buffer.from(await response.arrayBuffer()),
        fs.readFileSync(file),
        `${pathname} did not return ${file}`
    );
    return response;
}

test('[FRT-01] root and index.html use the React document', async () => {
    const frontendIndex = path.join(FRONTEND_ROOT, 'index.html');

    await assertFileResponse('/', frontendIndex);
    await assertFileResponse('/index.html', frontendIndex);
});

test('[FRT-02] real prerendered documents and selective SPA routes use build/client', async () => {
    for (const route of [
        'account/login',
        'account/register',
        'about',
        'events',
        'recommendations',
        'live',
        'community',
        'community/exchange',
        'community/cards',
        'producer-map',
        'works',
        'works/765',
        'works/cg',
        'works/ml',
        'works/sidem',
        'works/sc',
        'works/gakuen',
        'works/games',
        'works/wows',
        'wiki',
        'wiki/modern',
        'wiki/classic',
        'story',
        'story/modern',
        'story/classic',
        'chronicle'
    ]) {
        await assertFileResponse(`/${route}`, path.join(FRONTEND_ROOT, route, 'index.html'));
        await assertFileResponse(`/${route}/`, path.join(FRONTEND_ROOT, route, 'index.html'));
    }

    const fallback = path.join(FRONTEND_ROOT, '__spa-fallback.html');
    for (const route of [
        '/admin',
        '/admin/',
        '/admin/login',
        '/admin/login/',
        '/admin/chronicle/pending',
        '/information/info-example-001',
        '/chronicle/2026%E5%B9%BF%E5%B7%9E%E5%81%B6%E5%83%8F%E5%A4%A7%E5%B8%88Only',
        '/chronicle/activity-1/',
        '/community/exchange/me',
        '/community/exchange/me/',
        '/community/exchange/offices/shanghai-weekend',
        '/community/exchange/offices/shanghai-weekend/'
    ]) {
        await assertFileResponse(route, fallback);
    }

    const head = await request('/chronicle/activity-1', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.equal(head.headers.get('content-length'), String(fs.statSync(fallback).size));
});

test('[FRT-03] Hono routes, server 404s, and media ownership are never SPA fallbacks', async () => {
    const probe = await request('/api/wiki/test');
    assert.equal(probe.status, 200);
    assert.deepEqual(await probe.json(), { status: 'ok' });

    for (const pathname of [
        '/api/not-a-real-route',
        '/image/not-a-real-file.webp',
        '/css/not-a-real-file.css',
        '/icon/not-a-real-file.webp',
        '/uploads/not-a-real-file.png',
        '/eventchronicle/not-a-real-route',
        '/assets/images/eventchronicle/events/used/not-a-real-file.png',
        '/runninggame/Build/not-a-real-file.data',
        '/runninggame/BuildMobile/not-a-real-file.data'
    ]) {
        assert.deepEqual(
            resolveFrontendRoute({ method: 'GET', pathname }, frontendFiles),
            { kind: 'server' },
            pathname
        );
        const response = await request(pathname);
        assert.equal(response.status, 404, pathname);
        assert.equal(await response.text(), 'Not Found', pathname);
    }

    const sensitive = await request('/assets/images/eventchronicle/events/meta/private.json');
    assert.equal(sensitive.status, 403);
    assert.equal(await sensitive.text(), 'Forbidden');

    for (const pathname of [
        '/sites/hiro-2026',
        '/site-content/hiro-2026/22222222-2222-4222-8222-222222222222/index.html',
        '/information/info-example-001/content'
    ]) {
        assert.deepEqual(
            resolveFrontendRoute({ method: 'GET', pathname }, frontendFiles),
            { kind: 'server' },
            pathname
        );
    }
});

test('[FRT-04] unknown and ambiguous paths do not receive the SPA fallback', async () => {
    for (const pathname of [
        '/unknown',
        '/wiki/not-a-real-route',
        '/wiki/classic/extra-segment',
        '/story-not-a-real-route',
        '/story/extra-segment',
        '/story/classic/extra-segment',
        '/chronicle/one/two',
        '/chronicle/one%2Ftwo',
        '/chronicle/one%5Ctwo',
        '/community/exchange/offices/one/two',
        '/community/exchange/offices/one%2Ftwo',
        '/community/exchange/offices/one%5Ctwo',
        '/community/exchange/offices//',
        '/community/exchange/me/extra',
        '/chro%6Eicle/activity-1',
        '/admin%2Flogin',
        '/ad%6Din/login',
        '/admin//',
        '/chronicle/activity-1//',
        '/__spa-fallback.html',
        '/about/index.html',
        `/${frontendFileList.find((file) => file.endsWith('.js'))}/`,
        '/about/extra'
    ]) {
        const response = await request(pathname);
        assert.equal(response.status, 404, pathname);
        assert.equal(await response.text(), 'Not Found', pathname);
    }

    for (const pathname of [
        '/chronicle/.',
        '/chronicle/..',
        '/chronicle/%2e',
        '/chronicle/%2e%2e',
        '/admin/../api'
    ]) {
        assert.notEqual(
            resolveFrontendRoute({ method: 'GET', pathname }, frontendFiles).kind,
            'frontend',
            pathname
        );
    }

    for (const pathname of [
        '/about',
        '/admin',
        '/recommendations',
        '/information/info-example-001',
        '/chronicle/activity-1',
        '/community/exchange/me',
        '/community/exchange/offices/shanghai-weekend'
    ]) {
        assert.deepEqual(
            resolveFrontendRoute({ method: 'POST', pathname }, frontendFiles),
            { kind: 'server' },
            pathname
        );
        const response = await request(pathname, { method: 'POST' });
        assert.equal(response.status, 404, pathname);
    }
});

test('[FRT-05] build assets require an exact entry in the real file set', async () => {
    const javascript = frontendFileList.find((file) =>
        file.startsWith('assets/') && file.endsWith('.js')
    );
    assert.ok(javascript, 'build/client must contain a compiled JavaScript asset');
    await assertFileResponse(`/${javascript}`, path.join(FRONTEND_ROOT, javascript));

    for (const pathname of [
        `/${javascript}.map`,
        '/assets/not-in-the-build.js',
        '/brand/not-in-the-build.png'
    ]) {
        const response = await request(pathname);
        assert.equal(response.status, 404, pathname);
        assert.equal(await response.text(), 'Not Found', pathname);
    }

    assert.deepEqual(
        resolveFrontendRoute({ method: 'GET', pathname: `/${javascript}` }, new Set()),
        { kind: 'not-found' }
    );
});

test('[FRT-06] legacy browser URLs redirect to their modern owners', async () => {
    const redirects = new Map([
        ['/About.html', '/about'],
        ['/Event.html', '/events'],
        ['/producer.html', '/admin/login'],
        ['/producermap.html', '/producer-map'],
        ['/ProducerNameCard.html', '/community/cards'],
        ['/timeline.html', '/chronicle'],
        ['/eventchronicleadmin.html', '/admin/chronicle'],
        ['/283Introduction.html', '/works/sc'],
        ['/WOWSIntroduction.html', '/works/wows'],
        ['/hiro2026.html', '/sites/hiro2026'],
        ['/eventchronicle.html?id=activity%201', '/chronicle/activity%201']
    ]);

    for (const [legacyPath, destination] of redirects) {
        const response = await request(legacyPath, { redirect: 'manual' });
        assert.equal(response.status, 301, legacyPath);
        assert.equal(
            new URL(response.headers.get('location'), 'http://ims.test').pathname,
            destination,
            legacyPath
        );
    }
});
