const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { after, before, test } = require('node:test');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const sharp = require('sharp');
const { migratePostgres } = require('../scripts/migration/postgres-migrations.js');
const {
    assertCoreAuthContract,
    assertMediaRangeContract,
    assertMultipartParserContract,
    assertReactionContract,
    assertRejectedJwtContract
} = require('./contracts/runtime-contracts.js');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SERVER_ENTRY = path.join(PROJECT_ROOT, 'dist/server/main.js');
const LEGACY_SERVER_ENTRY = path.join(PROJECT_ROOT, 'js/server.js');
process.env.IMS_ENV_FILE = '';
let NAMECARD_DIR;
let EVENT_DIR;
const TEST_FILE_PREFIX = `security-${process.pid}-${Date.now()}`;
const APPROVED_FRONT_URL = `/uploads/namecard/original/${TEST_FILE_PREFIX}-approved-front.png`;
const APPROVED_BACK_URL = `/uploads/namecard/original/${TEST_FILE_PREFIX}-approved-back.png`;
const PENDING_FRONT_URL = `/uploads/namecard/original/${TEST_FILE_PREFIX}-pending-front.png`;
const PENDING_BACK_URL = `/uploads/namecard/original/${TEST_FILE_PREFIX}-pending-back.png`;

let baseUrl;
let closeDatabase;
let chronicleBase;
let databaseName;
let databaseUrl;
let fixturePool;
let server;
let tempDir;
let validPng;

function run(db, sql, params = []) {
    return db.query(translateParameters(sql), params).then((result) => ({
        changes: result.rowCount,
        lastID: result.rows[0]?.id
    }));
}

function get(db, sql, params = []) {
    return db.query(translateParameters(sql), params).then((result) => result.rows[0]);
}

function translateParameters(sql) {
    let index = 0;
    return sql.replace(/\?/g, () => `$${++index}`);
}

function jwtPart(value) {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
}

async function signJwtWithWebCrypto(header, claims, secret, hash = 'SHA-256') {
    const signingInput = `${jwtPart(header)}.${jwtPart(claims)}`;
    const key = await nodeCrypto.webcrypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash },
        false,
        ['sign']
    );
    const signature = await nodeCrypto.webcrypto.subtle.sign(
        'HMAC',
        key,
        new TextEncoder().encode(signingInput)
    );
    return `${signingInput}.${Buffer.from(signature).toString('base64url')}`;
}

async function verifyJwtWithWebCrypto(token, secret) {
    const [header, payload, signature] = token.split('.');
    const key = await nodeCrypto.webcrypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['verify']
    );
    return nodeCrypto.webcrypto.subtle.verify(
        'HMAC',
        key,
        Buffer.from(signature, 'base64url'),
        new TextEncoder().encode(`${header}.${payload}`)
    );
}

function isolatedServerEnv(label) {
    return {
        ...process.env,
        NODE_ENV: 'test',
        IMS_JWT_SECRET: 'test-only-secret-with-sufficient-entropy',
        DATABASE_URL: databaseUrl,
        IMS_OBJECT_STORAGE: 'filesystem',
        IMS_COMPENSATION_DIR: path.join(tempDir, `${label}-compensation`),
        IMS_UPLOADS_DIR: path.join(tempDir, `${label}-uploads`),
        IMS_EVENT_BASE_DIR: path.join(tempDir, `${label}-events`)
    };
}

function namecardObjectPath(publicUrl) {
    const filename = path.basename(publicUrl);
    const extension = path.extname(filename).toLowerCase();
    const stem = path.basename(filename, extension);
    return path.join(NAMECARD_DIR, stem, `image${extension}`);
}

before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ims-node-security-'));
    const uploadsDir = path.join(tempDir, 'uploads');
    NAMECARD_DIR = path.join(uploadsDir, 'community/namecards/assets');
    EVENT_DIR = path.join(uploadsDir, 'editorial/events/assets');
    fs.mkdirSync(NAMECARD_DIR, { recursive: true });
    fs.mkdirSync(EVENT_DIR, { recursive: true });
    const adminUrl = process.env.IMS_TEST_DATABASE_URL ||
        'postgresql://imsweb:imsweb-local-password@127.0.0.1:5432/postgres';
    databaseName = `ims_security_${process.pid}_${Date.now()}`;
    const adminPool = new Pool({ connectionString: adminUrl });
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    await adminPool.end();
    const parsedDatabaseUrl = new URL(adminUrl);
    parsedDatabaseUrl.pathname = `/${databaseName}`;
    databaseUrl = parsedDatabaseUrl.toString();
    await migratePostgres({ connectionString: databaseUrl });
    fixturePool = new Pool({ connectionString: databaseUrl, allowExitOnIdle: true });
    const passwordHash = await bcrypt.hash('test-password', 4);

    for (let id = 1; id <= 3; id += 1) {
        await run(
            fixturePool,
            `INSERT INTO news (title, image, thumbnail, content, date, author)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                `Seed news ${id}`,
                `/uploads/news/original/${id}.webp`,
                `/uploads/news/thumb/${id}.webp`,
                `https://example.test/news/${id}`,
                `2026-07-0${id}`,
                'Security fixture'
            ]
        );
    }
    await run(
        fixturePool,
        `INSERT INTO cards (image1_url, image2_url, hash1, hash2, ip, status)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [APPROVED_FRONT_URL, APPROVED_BACK_URL, 'private-hash-1', 'private-hash-2', '203.0.113.8', 'approved']
    );
    await run(
        fixturePool,
        `INSERT INTO cards (image1_url, image2_url, hash1, hash2, ip, status)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [PENDING_FRONT_URL, PENDING_BACK_URL, 'pending-hash-1', 'pending-hash-2', '198.51.100.9', 'pending']
    );
    await run(
        fixturePool,
        'INSERT INTO users (username, password, dept, producername) VALUES (?, ?, ?, ?)',
        ['security-test-op', passwordHash, 'op', 'Security Test']
    );
    validPng = await sharp({
        create: {
            width: 2,
            height: 2,
            channels: 3,
            background: { r: 120, g: 40, b: 200 }
        }
    }).png().toBuffer();
    for (const mediaUrl of [
        APPROVED_FRONT_URL,
        APPROVED_BACK_URL,
        PENDING_FRONT_URL,
        PENDING_BACK_URL
    ]) {
        const target = namecardObjectPath(mediaUrl);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, validPng);
    }

    process.env.NODE_ENV = 'test';
    process.env.IMS_JWT_SECRET = 'test-only-secret-with-sufficient-entropy';
    process.env.DATABASE_URL = databaseUrl;
    process.env.IMS_OBJECT_STORAGE = 'filesystem';
    process.env.IMS_COMPENSATION_DIR = path.join(tempDir, 'compensation');
    process.env.IMS_UPLOADS_DIR = uploadsDir;
    process.env.IMS_COOKIE_SECURE = 'false';
    chronicleBase = path.join(tempDir, 'event-chronicle');
    process.env.IMS_EVENT_BASE_DIR = chronicleBase;

    const serverModule = require(SERVER_ENTRY);
    closeDatabase = serverModule.closeDatabase;
    server = serverModule.startServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    if (server?.listening) {
        await new Promise((resolve, reject) => {
            server.close(err => err ? reject(err) : resolve());
        });
    }
    if (closeDatabase) await closeDatabase();
    if (fixturePool) await fixturePool.end();
    if (databaseName) {
        const adminUrl = process.env.IMS_TEST_DATABASE_URL ||
            'postgresql://imsweb:imsweb-local-password@127.0.0.1:5432/postgres';
        const adminPool = new Pool({ connectionString: adminUrl });
        await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
        await adminPool.end();
    }
    for (const filename of fs.readdirSync(NAMECARD_DIR)) {
        if (filename.startsWith(TEST_FILE_PREFIX)) {
            fs.rmSync(path.join(NAMECARD_DIR, filename), { recursive: true, force: true });
        }
    }
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

test('sensitive files and virtual environments are blocked before static serving', async () => {
    const sensitivePaths = [
        '/idol_data.db',
        '/uploads/idol_data.db',
        '/idol_data.db-wal',
        '/idol_data.db-journal',
        '/database-cache.wal',
        '/app.py',
        '/uwsgi.ini',
        '/logs/error.log',
        '/requirements.txt',
        '/README.md',
        '/templates/story.html',
        '/Data/private-image.webp',
        '/assets/images/eventchronicle/events/meta/private.json',
        '/assets/images/eventchronicle/events/.idempotency/private.json',
        '/icon/title(1).7z',
        '/venv/lib/python/site.py',
        '/3250ee7dc65bd965bbd1529ba5c2d732_venv/get-pip.py',
        '/%2561pp.py'
    ];

    for (const requestPath of sensitivePaths) {
        const response = await fetch(`${baseUrl}${requestPath}`);
        assert.equal(response.status, 403, requestPath);
    }
});

async function getOpToken() {
    const response = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'security-test-op', password: 'test-password' })
    });
    assert.equal(response.status, 200);
    return (await response.json()).token;
}

async function getOpSession() {
    const response = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'security-test-op', password: 'test-password' })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    const cookies = response.headers.getSetCookie().map(value => value.split(';', 1)[0]);
    const csrfCookie = cookies.find(value => value.startsWith('csrf_token='));
    return {
        token: body.token,
        cookie: cookies.join('; '),
        csrf: decodeURIComponent(csrfCookie.slice('csrf_token='.length))
    };
}

function rawRequest(requestPath, options = {}) {
    const address = server.address();
    return new Promise((resolve, reject) => {
        const request = http.request({
            host: '127.0.0.1',
            port: address.port,
            path: requestPath,
            method: options.method || 'GET',
            headers: options.headers || {}
        }, response => {
            response.resume();
            response.on('end', () => resolve(response));
        });
        request.on('error', reject);
        request.end(options.body);
    });
}

test('raw dot segments cannot bypass sensitive static path checks', async () => {
    const paths = [
        '/x/../templates/story.html',
        '/assets/images/eventchronicle/events/x/../meta/2026IFE2.json',
        '/assets/images/eventchronicle/events/%2e%2e/meta/private.json'
    ];
    for (const requestPath of paths) {
        const response = await rawRequest(requestPath);
        assert.equal(response.statusCode, 403, requestPath);
    }
});

test('unauthenticated management routes return 401', async () => {
    const requests = [
        ['/api/events', { method: 'POST' }],
        ['/api/events/1', { method: 'DELETE' }],
        ['/eventchronicle/admin', {}],
        ['/eventchronicle/admin/pending', {}],
        ['/eventchronicle/admin/used', {}],
        ['/eventchronicle/admin/approve/1/photo.jpg', { method: 'POST' }],
        ['/eventchronicle/admin/reject/1/photo.jpg', { method: 'POST' }],
        ['/eventchronicle/admin/delete-used/1/photo.jpg', { method: 'DELETE' }]
    ];

    for (const [requestPath, options] of requests) {
        const response = await fetch(`${baseUrl}${requestPath}`, options);
        assert.equal(response.status, 401, `${options.method || 'GET'} ${requestPath}`);
    }
});

test('public card endpoints only expose approved non-sensitive data', async () => {
    const listResponse = await fetch(`${baseUrl}/api/cards?page=1&size=25`);
    assert.equal(listResponse.status, 200);
    const page = await listResponse.json();
    assert.equal(page.total, 1);
    assert.equal(page.list.length, 1);
    assert.equal(page.list[0].image1_url, APPROVED_FRONT_URL);

    for (const privateField of ['ip', 'hash1', 'hash2']) {
        assert.equal(Object.hasOwn(page.list[0], privateField), false, privateField);
    }

    const approvedResponse = await fetch(`${baseUrl}/api/card/1`);
    assert.deepEqual(await approvedResponse.json(), {
        image1_url: APPROVED_FRONT_URL,
        image2_url: APPROVED_BACK_URL
    });

    const pendingResponse = await fetch(`${baseUrl}/api/card/2`);
    assert.deepEqual(await pendingResponse.json(), {});
});

test('namecard files and thumbnails enforce approval or op access', async () => {
    const approved = await fetch(`${baseUrl}${APPROVED_FRONT_URL}`);
    assert.equal(approved.status, 200);

    const pending = await fetch(`${baseUrl}${PENDING_FRONT_URL}`);
    assert.equal(pending.status, 401);

    const token = await getOpToken();
    const pendingForOp = await fetch(`${baseUrl}${PENDING_FRONT_URL}`, {
        headers: { authorization: token }
    });
    assert.equal(pendingForOp.status, 200);
    assert.equal(pendingForOp.headers.get('cache-control'), 'private, no-store');

    const approvedThumbnail = await fetch(
        `${baseUrl}/api/thumbnail?url=${encodeURIComponent(APPROVED_FRONT_URL)}&width=20&height=20`
    );
    assert.equal(approvedThumbnail.status, 200);
    assert.match(approvedThumbnail.headers.get('content-type'), /^image\/jpeg/);

    const privateThumbnail = await fetch(
        `${baseUrl}/api/thumbnail?url=${encodeURIComponent(PENDING_FRONT_URL)}`
    );
    assert.equal(privateThumbnail.status, 401);

    const privateThumbnailForOp = await fetch(
        `${baseUrl}/api/thumbnail?url=${encodeURIComponent(PENDING_FRONT_URL)}`,
        { headers: { authorization: token } }
    );
    assert.equal(privateThumbnailForOp.status, 200);
    assert.equal(privateThumbnailForOp.headers.get('cache-control'), 'private, no-store');

    const sourceThumbnail = await fetch(
        `${baseUrl}/api/thumbnail?url=${encodeURIComponent('/app.py')}`
    );
    assert.equal(sourceThumbnail.status, 403);
});

test('spoofed image uploads are rejected without leaving files behind', async () => {
    const uploadDir = NAMECARD_DIR;
    const before = new Set(fs.readdirSync(uploadDir));
    const form = new FormData();
    form.append('images', new Blob(['not an image'], { type: 'image/jpeg' }), 'front.jpg');
    form.append('images', new Blob(['still not an image'], { type: 'image/jpeg' }), 'back.jpg');

    const response = await fetch(`${baseUrl}/api/uploadNameCard`, {
        method: 'POST',
        body: form
    });
    assert.equal(response.status, 400);
    assert.deepEqual(new Set(fs.readdirSync(uploadDir)), before);
});

test('login token cookie is HttpOnly', async () => {
    const response = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'security-test-op', password: 'test-password' })
    });
    assert.equal(response.status, 200);
    const cookies = response.headers.getSetCookie();
    const tokenCookie = cookies.find(cookie => cookie.startsWith('token='));
    assert.ok(tokenCookie, 'token cookie is present');
    assert.match(tokenCookie, /; HttpOnly/i);
});

test('malformed login input is rejected without terminating the server', async () => {
    for (const body of [
        { username: 'security-test-op' },
        { username: 'security-test-op', password: null },
        { username: 'security-test-op', password: {} }
    ]) {
        const response = await fetch(`${baseUrl}/api/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
        });
        assert.equal(response.status, 400);
    }
    assert.equal((await fetch(`${baseUrl}/api/news`)).status, 200);
});

test('compiled Node news route preserves legacy responses and snapshot pagination', async () => {
    const legacy = await fetch(`${baseUrl}/api/news`);
    assert.equal(legacy.status, 200);
    const legacyBody = await legacy.json();
    assert.equal(Array.isArray(legacyBody), true);
    assert.deepEqual(legacyBody.map((item) => item.id), [3, 2, 1]);

    const first = await fetch(`${baseUrl}/api/news?limit=2`);
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.deepEqual(firstBody.items.map((item) => item.id), [3, 2]);
    assert.equal(firstBody.pageInfo.hasNextPage, true);
    assert.equal(firstBody.pageInfo.snapshotAt, '3');

    await run(
        fixturePool,
        `INSERT INTO news (title, image, thumbnail, content, date, author)
         VALUES ('New after snapshot', '', '', 'https://example.test/new', '2026-07-24', 'Fixture')`
    );

    const second = await fetch(
        `${baseUrl}/api/news?limit=2&cursor=${encodeURIComponent(firstBody.pageInfo.nextCursor)}`
    );
    assert.equal(second.status, 200);
    const secondBody = await second.json();
    assert.deepEqual(secondBody.items.map((item) => item.id), [1]);
    assert.deepEqual(secondBody.pageInfo, {
        nextCursor: null,
        hasNextPage: false,
        snapshotAt: '3'
    });

    const refreshed = await fetch(`${baseUrl}/api/news?limit=1`);
    assert.equal((await refreshed.json()).items[0].id, 4);
    assert.equal((await fetch(`${baseUrl}/api/news?limit=0`)).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/news?cursor=invalid`)).status, 400);
});

test('news publishing rejects missing bodies and unsafe links', async () => {
    const token = await getOpToken();
    const missingBody = await fetch(`${baseUrl}/api/admin/news`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(missingBody.status, 400);

    const unsafeLink = await fetch(`${baseUrl}/api/admin/news`, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json'
        },
        body: JSON.stringify({ title: 'unsafe', content: 'javascript:alert(1)' })
    });
    assert.equal(unsafeLink.status, 400);
    assert.equal((await fetch(`${baseUrl}/api/news`)).status, 200);
});

test('information management hosts images and publishes sandboxed HTML content', async () => {
    const token = await getOpToken();
    const auth = { authorization: `Bearer ${token}` };
    const unauthorized = await fetch(`${baseUrl}/api/admin/information`);
    assert.equal(unauthorized.status, 401);

    const upload = new FormData();
    upload.append('image', new Blob([validPng], { type: 'image/png' }), 'contract-cover.png');
    const uploaded = await fetch(`${baseUrl}/api/admin/information/assets`, {
        method: 'POST',
        headers: auth,
        body: upload
    });
    assert.equal(uploaded.status, 200);
    const assetUrl = (await uploaded.json()).url;
    assert.match(assetUrl, /^\/uploads\/information\/original\/.+\.webp$/);
    const publicAsset = await fetch(`${baseUrl}${assetUrl}`);
    assert.equal(publicAsset.status, 200);
    assert.equal(publicAsset.headers.get('content-type'), 'image/webp');

    const created = await fetch(`${baseUrl}/api/admin/information`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({
            title: 'Node HTML contract',
            category: 'activity',
            contentType: 'html',
            externalUrl: '',
            html: `<h2>Hosted HTML</h2><img src="${assetUrl}">`,
            image: assetUrl
        })
    });
    assert.equal(created.status, 200);
    const createdCard = (await created.json()).card;

    const publicIndex = await fetch(`${baseUrl}/api/information`);
    assert.equal(publicIndex.status, 200);
    const summary = (await publicIndex.json()).cards.find(card => card.id === createdCard.id);
    assert.equal(summary.title, 'Node HTML contract');
    assert.equal('html' in summary, false);

    const detail = await fetch(`${baseUrl}/api/information/${createdCard.id}`);
    assert.equal(detail.status, 200);
    assert.match((await detail.json()).card.html, /Hosted HTML/);

    const document = await fetch(`${baseUrl}/information/${createdCard.id}/content`);
    assert.equal(document.status, 200);
    assert.match(document.headers.get('content-type'), /^text\/html/);
    assert.match(document.headers.get('content-security-policy'), /script-src 'none'/);
    assert.equal(document.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.match(await document.text(), /Hosted HTML/);

    const removed = await fetch(`${baseUrl}/api/admin/information/${createdCard.id}`, {
        method: 'DELETE',
        headers: auth
    });
    assert.equal(removed.status, 200);
    assert.equal(
        (await fetch(`${baseUrl}/information/${createdCard.id}/content`)).status,
        404
    );
    const removedAsset = await fetch(`${baseUrl}/api/admin/information/assets`, {
        method: 'DELETE',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ url: assetUrl })
    });
    assert.equal(removedAsset.status, 200);
    assert.equal((await fetch(`${baseUrl}${assetUrl}`)).status, 404);
});

test('reactions require an approved card and a supported value', async () => {
    const unsupported = await fetch(`${baseUrl}/api/reactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 1, emoji: 'not-allowed' })
    });
    assert.equal(unsupported.status, 400);

    const missingCard = await fetch(`${baseUrl}/api/reactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 999999, emoji: '👍' })
    });
    assert.equal(missingCard.status, 404);

    const accepted = await fetch(`${baseUrl}/api/reactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 1, emoji: '👍' })
    });
    assert.equal(accepted.status, 200);

    const listed = await fetch(`${baseUrl}/api/reactions?id=1`);
    assert.equal(listed.status, 200);
    assert.equal((await listed.json())['👍'], 1);
});

test('cookie-authenticated writes require CSRF while bearer writes remain compatible', async () => {
    const session = await getOpSession();
    const withoutCsrf = await fetch(`${baseUrl}/api/events`, {
        method: 'POST',
        headers: { cookie: session.cookie }
    });
    assert.equal(withoutCsrf.status, 403);

    const wrongCsrf = await fetch(`${baseUrl}/api/events`, {
        method: 'POST',
        headers: { cookie: session.cookie, 'x-csrftoken': 'wrong' }
    });
    assert.equal(wrongCsrf.status, 403);

    const withCsrf = await fetch(`${baseUrl}/api/events`, {
        method: 'POST',
        headers: { cookie: session.cookie, 'x-csrftoken': session.csrf }
    });
    assert.equal(withCsrf.status, 400);

    const bearer = await fetch(`${baseUrl}/api/events`, {
        method: 'POST',
        headers: { authorization: `Bearer ${session.token}` }
    });
    assert.equal(bearer.status, 400);
});

test('[AUTH-01 CORE-01] shared auth contract runs against Node PostgreSQL and filesystem services', async () => {
    const userRow = await get(fixturePool, "SELECT id, username, dept FROM users WHERE username='security-test-op'");
    const user = { ...userRow, id: Number(userRow.id) };
    const inserted = await run(
        fixturePool,
        `INSERT INTO cards (image1_url, image2_url, hash1, hash2, ip, status)
         VALUES (?, ?, ?, ?, ?, 'pending') RETURNING id`,
        ['/contract-front.webp', '/contract-back.webp', 'contract-front', 'contract-back', '127.0.0.1']
    );

    const request = (requestPath, init) => fetch(`${baseUrl}${requestPath}`, init);
    try {
        await assertCoreAuthContract({
            runtime: 'Node',
            expectedUser: user,
            request,
            cookieMutationPath: `/api/admin/cards/approve/${inserted.lastID}`,
            secureCookies: false,
            async login() {
                const response = await request('/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: 'security-test-op', password: 'test-password' })
                });
                const body = await response.json();
                const cookies = response.headers.getSetCookie().map((value) => value.split(';', 1)[0]);
                const csrfCookie = cookies.find((value) => value.startsWith('csrf_token='));
                return {
                    response,
                    token: body.token,
                    cookie: cookies.join('; '),
                    csrf: decodeURIComponent(csrfCookie.slice('csrf_token='.length))
                };
            },
            async assertMutationState(state) {
                const row = await get(fixturePool, 'SELECT status FROM cards WHERE id=?', [inserted.lastID]);
                assert.equal(row.status, state === 'before' ? 'pending' : 'approved');
            },
            async resetMutation() {
                await run(fixturePool, "UPDATE cards SET status='pending' WHERE id=?", [inserted.lastID]);
            },
            setCookies(response) {
                return response.headers.getSetCookie();
            }
        });
    } finally {
        await run(fixturePool, 'DELETE FROM cards WHERE id=?', [inserted.lastID]);
    }
});

test('[AUTH-01] Node and WebCrypto JWTs interoperate and invalid token classes stay rejected', async () => {
    const secret = process.env.IMS_JWT_SECRET;
    const now = Math.floor(Date.now() / 1000);
    const nodeSession = await getOpSession();
    const nodeClaims = JSON.parse(
        Buffer.from(nodeSession.token.split('.')[1], 'base64url').toString('utf8')
    );
    assert.equal(typeof nodeClaims.iss, 'string');
    assert.equal(nodeClaims.aud, 'ims-backoffice');
    assert.equal(nodeClaims.kind, 'backoffice');
    const claims = {
        id: 1,
        username: 'webcrypto-minted-op',
        producername: 'WebCrypto Minted',
        dept: 'op',
        csrfSecret: 'webcrypto-minted-csrf',
        iss: nodeClaims.iss,
        aud: 'ims-backoffice',
        kind: 'backoffice',
        iat: now,
        exp: now + 600
    };
    const webCryptoMinted = await signJwtWithWebCrypto({ alg: 'HS256', typ: 'JWT' }, claims, secret);
    const accepted = await fetch(`${baseUrl}/api/admin/auth/session`, {
        headers: { Authorization: `Bearer ${webCryptoMinted}` }
    });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).user.username, 'webcrypto-minted-op');

    assert.equal(await verifyJwtWithWebCrypto(nodeSession.token, secret), true);

    await assertRejectedJwtContract({
        runtime: 'Node',
        request: (requestPath, init) => fetch(`${baseUrl}${requestPath}`, init),
        tokens: {
            'non-HS256': await signJwtWithWebCrypto(
                { alg: 'HS512', typ: 'JWT' }, claims, secret, 'SHA-512'
            ),
            expired: await signJwtWithWebCrypto(
                { alg: 'HS256', typ: 'JWT' }, { ...claims, iat: now - 120, exp: now - 60 }, secret
            ),
            'missing-CSRF-claim': await signJwtWithWebCrypto(
                { alg: 'HS256', typ: 'JWT' }, { ...claims, csrfSecret: undefined }, secret
            ),
            'missing-issuer': await signJwtWithWebCrypto(
                { alg: 'HS256', typ: 'JWT' }, { ...claims, iss: undefined }, secret
            ),
            'wrong-issuer': await signJwtWithWebCrypto(
                { alg: 'HS256', typ: 'JWT' }, { ...claims, iss: `${claims.iss}-other` }, secret
            ),
            'missing-audience': await signJwtWithWebCrypto(
                { alg: 'HS256', typ: 'JWT' }, { ...claims, aud: undefined }, secret
            ),
            'platform-audience': await signJwtWithWebCrypto(
                { alg: 'HS256', typ: 'JWT' }, { ...claims, aud: 'ims-platform' }, secret
            ),
            'missing-kind': await signJwtWithWebCrypto(
                { alg: 'HS256', typ: 'JWT' }, { ...claims, kind: undefined }, secret
            ),
            'platform-kind': await signJwtWithWebCrypto(
                { alg: 'HS256', typ: 'JWT' }, { ...claims, kind: 'platform' }, secret
            ),
            'wrong-secret': await signJwtWithWebCrypto(
                { alg: 'HS256', typ: 'JWT' }, claims, 'wrong-secret-that-is-at-least-32-bytes'
            )
        }
    });
});

test('[CORE-01] shared reaction contract runs against Node PostgreSQL', async () => {
    const inserted = await run(
        fixturePool,
        `INSERT INTO cards (image1_url, image2_url, status)
         VALUES ('/contract-reaction-front.webp', '/contract-reaction-back.webp', 'approved')
         RETURNING id`
    );
    try {
        await assertReactionContract({
            runtime: 'Node',
            cardId: inserted.lastID,
            request: (requestPath, init) => fetch(`${baseUrl}${requestPath}`, init)
        });
    } finally {
        await run(fixturePool, 'DELETE FROM card_emojis WHERE card_id=?', [inserted.lastID]);
        await run(fixturePool, 'DELETE FROM cards WHERE id=?', [inserted.lastID]);
    }
});

test('[MEDIA-01] shared GET/HEAD and range matrix runs against Node filesystem media', async () => {
    await assertMediaRangeContract({
        runtime: 'Node',
        path: APPROVED_FRONT_URL,
        body: new Uint8Array(validPng),
        contentType: 'image/png',
        etag: `"${nodeCrypto.createHash('sha256').update(validPng).digest('hex')}"`,
        request: (requestPath, init) => fetch(`${baseUrl}${requestPath}`, init)
    });
});

test('[MEDIA-01 NODE-01] shared multipart contract runs against Node streaming parser', async () => {
    const { StreamingUploadParser } = require(path.join(
        PROJECT_ROOT,
        'dist/server/infra/http/busboy/upload-parser.js'
    ));
    const parser = new StreamingUploadParser();
    await assertMultipartParserContract({
        runtime: 'Node',
        parse: (request, options) => parser.parse(request, options),
        request(body, contentType) {
            return new Request('http://ims.test/upload', {
                method: 'POST',
                headers: { 'Content-Type': contentType },
                body
            });
        }
    });
});

test('event deletion survives media cleanup failure after database commit', async () => {
    const filename = `${TEST_FILE_PREFIX}-cleanup-failure.png`;
    const extension = path.extname(filename);
    const mediaPath = path.join(
        EVENT_DIR,
        path.basename(filename, extension),
        `poster${extension}`
    );
    fs.mkdirSync(path.dirname(mediaPath), { recursive: true });
    fs.mkdirSync(mediaPath);

    const insert = await run(
        fixturePool,
        'INSERT INTO events (title, name, contact, image_url) VALUES (?, ?, ?, ?) RETURNING id',
        ['cleanup test', 'test', 'test', `/uploads/event/original/${filename}`]
    );

    try {
        const token = await getOpToken();
        const response = await fetch(`${baseUrl}/api/events/${insert.lastID}`, {
            method: 'DELETE',
            headers: { authorization: token }
        });
        assert.equal(response.status, 200);

        const row = await get(fixturePool, 'SELECT id FROM events WHERE id = ?', [insert.lastID]);
        assert.equal(row, undefined);
        assert.equal(fs.lstatSync(mediaPath).isDirectory(), true);
    } finally {
        fs.rmSync(mediaPath, { recursive: true, force: true });
    }
});

test('pending chronicle media requires op authentication', async () => {
    const pendingDir = path.join(chronicleBase, 'media/pending', 'activity-one');
    fs.mkdirSync(pendingDir, { recursive: true });
    fs.writeFileSync(path.join(pendingDir, 'photo.jpg'), 'test image');

    const unauthenticated = await fetch(
        `${baseUrl}/assets/images/eventchronicle/events/upload/activity-one/photo.jpg`
    );
    assert.equal(unauthenticated.status, 401);

    const token = await getOpToken();
    const authenticated = await fetch(
        `${baseUrl}/assets/images/eventchronicle/events/upload/activity-one/photo.jpg`,
        { headers: { authorization: token } }
    );
    assert.equal(authenticated.status, 200);
    assert.equal(authenticated.headers.get('cache-control'), 'private, no-store');
});

test('chronicle upload commits files using the final multipart activityId', async () => {
    const activityId = 'activity-file-first';
    const form = new FormData();
    form.append('images', new Blob([validPng], { type: 'image/png' }), 'ordered.png');
    form.append('activityId', activityId);
    form.append('username', 'Uploader');

    const response = await fetch(`${baseUrl}/eventchronicle/upload`, {
        method: 'POST',
        body: form
    });
    assert.equal(response.status, 200);

    const metaPath = path.join(chronicleBase, 'metadata', `${activityId}.json`);
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    assert.equal(meta.records.length, 1);
    assert.equal(
        fs.existsSync(path.join(
            chronicleBase,
            'media/pending',
            activityId,
            meta.records[0].filename
        )),
        true
    );
    assert.deepEqual(fs.readdirSync(path.join(chronicleBase, '.staging')), []);
});

test('chronicle approval and rejection enforce pending state', async () => {
    const activityId = 'activity-state';
    const uploadDir = path.join(chronicleBase, 'media/pending', activityId);
    const usedDir = path.join(chronicleBase, 'media/published', activityId);
    const metaPath = path.join(chronicleBase, 'metadata', `${activityId}.json`);
    fs.mkdirSync(uploadDir, { recursive: true });
    fs.mkdirSync(usedDir, { recursive: true });
    fs.writeFileSync(path.join(uploadDir, 'pending.png'), validPng);
    fs.writeFileSync(path.join(uploadDir, 'orphan.png'), validPng);
    fs.writeFileSync(path.join(usedDir, 'approved.png'), validPng);
    fs.writeFileSync(metaPath, JSON.stringify({
        title: 'State test',
        records: [
            { filename: 'pending.png', status: 'pending' },
            { filename: 'approved.png', status: 'approved' },
            { filename: 'missing.png', status: 'pending' }
        ]
    }));
    const token = await getOpToken();
    const headers = { authorization: token };

    const approved = await fetch(
        `${baseUrl}/eventchronicle/admin/approve/${activityId}/pending.png`,
        { method: 'POST', headers }
    );
    assert.equal(approved.status, 200);
    assert.equal(fs.existsSync(path.join(usedDir, 'pending.png')), true);

    const orphan = await fetch(
        `${baseUrl}/eventchronicle/admin/approve/${activityId}/orphan.png`,
        { method: 'POST', headers }
    );
    assert.equal(orphan.status, 409);
    assert.equal(fs.existsSync(path.join(uploadDir, 'orphan.png')), true);

    const rejectApproved = await fetch(
        `${baseUrl}/eventchronicle/admin/reject/${activityId}/approved.png`,
        { method: 'POST', headers }
    );
    assert.equal(rejectApproved.status, 409);

    const rejectMissingFile = await fetch(
        `${baseUrl}/eventchronicle/admin/reject/${activityId}/missing.png`,
        { method: 'POST', headers }
    );
    assert.equal(rejectMissingFile.status, 200);

    const finalMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    assert.equal(finalMeta.records.find(record => record.filename === 'pending.png').status, 'approved');
    assert.equal(finalMeta.records.some(record => record.filename === 'approved.png'), true);
    assert.equal(finalMeta.records.some(record => record.filename === 'missing.png'), false);
});

test('chronicle listings share upload formats and safely encode legacy metadata', async () => {
    const activityId = 'activity-formats';
    const usedDir = path.join(chronicleBase, 'media/published', activityId);
    const metaDir = path.join(chronicleBase, 'metadata');
    fs.mkdirSync(usedDir, { recursive: true });
    fs.mkdirSync(metaDir, { recursive: true });
    fs.writeFileSync(
        path.join(usedDir, 'photo.jfif'),
        await sharp(validPng).jpeg().toBuffer()
    );
    fs.writeFileSync(path.join(metaDir, 'legacy-xss.json'), JSON.stringify({
        records: [{
            filename: 'legacy\"><img src=x onerror=alert(1)>.jpg',
            uploader: '<img src=x onerror=alert(1)>',
            status: 'pending'
        }]
    }));

    const token = await getOpToken();
    const used = await fetch(`${baseUrl}/eventchronicle/admin/used`, {
        headers: { authorization: token }
    });
    const usedData = await used.json();
    assert.equal(usedData[activityId][0].filename, 'photo.jfif');

    const pending = await fetch(`${baseUrl}/eventchronicle/admin/pending`, {
        headers: { authorization: token }
    });
    const pendingData = await pending.json();
    assert.match(pendingData['legacy-xss'][0].url, /%22%3E%3Cimg/);
});

test('chronicle deletion preserves object metadata and rejects traversal', async () => {
    const activityId = 'activity-delete';
    const usedDir = path.join(chronicleBase, 'media/published', activityId);
    const metaDir = path.join(chronicleBase, 'metadata');
    fs.mkdirSync(usedDir, { recursive: true });
    fs.mkdirSync(metaDir, { recursive: true });
    fs.writeFileSync(path.join(usedDir, 'photo.jpg'), 'test image');
    fs.writeFileSync(path.join(metaDir, `${activityId}.json`), JSON.stringify({
        title: 'Keep this title',
        records: [
            { filename: 'photo.jpg', status: 'approved' },
            { filename: 'other.jpg', status: 'approved' }
        ]
    }));

    const token = await getOpToken();
    const response = await fetch(
        `${baseUrl}/eventchronicle/admin/delete-used/${activityId}/photo.jpg`,
        { method: 'DELETE', headers: { authorization: token } }
    );
    assert.equal(response.status, 200);
    assert.equal(fs.existsSync(path.join(usedDir, 'photo.jpg')), false);

    const meta = JSON.parse(fs.readFileSync(path.join(metaDir, `${activityId}.json`), 'utf8'));
    assert.equal(meta.title, 'Keep this title');
    assert.deepEqual(meta.records, [{ filename: 'other.jpg', status: 'approved' }]);

    const traversal = await fetch(
        `${baseUrl}/eventchronicle/admin/delete-used/bad%2Fid/photo.jpg`,
        { method: 'DELETE', headers: { authorization: token } }
    );
    assert.equal(traversal.status, 400);
});

test('chronicle operations preserve decomposed Unicode path identity', async () => {
    const activityId = 'activity-e\u0301';
    const filename = 'photo-e\u0301.png';
    const usedDir = path.join(chronicleBase, 'media/published', activityId);
    const metaPath = path.join(chronicleBase, 'metadata', `${activityId}.json`);
    fs.mkdirSync(usedDir, { recursive: true });
    fs.writeFileSync(path.join(usedDir, filename), validPng);
    fs.writeFileSync(metaPath, JSON.stringify({
        records: [{ filename, status: 'approved' }]
    }));

    const token = await getOpToken();
    const response = await fetch(
        `${baseUrl}/eventchronicle/admin/delete-used/${encodeURIComponent(activityId)}/${encodeURIComponent(filename)}`,
        { method: 'DELETE', headers: { authorization: token } }
    );
    assert.equal(response.status, 200);
    assert.equal(fs.existsSync(path.join(usedDir, filename)), false);
});

test('public upload limiter rejects before Multer writes to disk', async () => {
    let limited = false;
    for (let attempt = 0; attempt < 35; attempt += 1) {
        const form = new FormData();
        form.append('images', new Blob(['invalid'], { type: 'text/plain' }), 'invalid.txt');
        const response = await fetch(`${baseUrl}/api/uploadNameCard`, {
            method: 'POST',
            body: form
        });
        if (response.status === 429) {
            limited = true;
            break;
        }
        assert.equal(response.status, 400);
    }
    assert.equal(limited, true);

    const namecardsBefore = new Set(fs.readdirSync(NAMECARD_DIR));
    const validNamecard = new FormData();
    validNamecard.append('images', new Blob([validPng], { type: 'image/png' }), 'front.png');
    validNamecard.append('images', new Blob([validPng], { type: 'image/png' }), 'back.png');
    const namecardResponse = await fetch(`${baseUrl}/api/uploadNameCard`, {
        method: 'POST',
        body: validNamecard
    });
    assert.equal(namecardResponse.status, 429);
    assert.deepEqual(new Set(fs.readdirSync(NAMECARD_DIR)), namecardsBefore);

    const blockedActivity = 'rate-limited-activity';
    const validChronicle = new FormData();
    validChronicle.append('activityId', blockedActivity);
    validChronicle.append('images', new Blob([validPng], { type: 'image/png' }), 'photo.png');
    const chronicleResponse = await fetch(`${baseUrl}/eventchronicle/upload`, {
        method: 'POST',
        body: validChronicle
    });
    assert.equal(chronicleResponse.status, 429);
    assert.equal(
        fs.existsSync(path.join(chronicleBase, 'upload', blockedActivity)),
        false
    );
});

test('compiled server entry exports the application lifecycle contract', () => {
    const serverModule = require(SERVER_ENTRY);

    assert.equal(typeof serverModule.app, 'function');
    assert.equal(typeof serverModule.startServer, 'function');
    assert.equal(typeof serverModule.closeDatabase, 'function');
});

test('requiring the compiled server entry does not start a listener', () => {
    const script = `
        const http = require('node:http');
        http.Server.prototype.listen = () => {
            throw new Error('server entry listened during require');
        };
        (async () => {
            const serverModule = require(${JSON.stringify(SERVER_ENTRY)});
            await serverModule.closeDatabase();
        })().catch(error => {
            console.error(error);
            process.exitCode = 1;
        });
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
        cwd: os.tmpdir(),
        env: isolatedServerEnv('require-without-listen'),
        encoding: 'utf8',
        timeout: 5000
    });

    assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('compiled server entry loads independently of the current working directory', () => {
    const script = `
        (async () => {
            const serverModule = require(${JSON.stringify(SERVER_ENTRY)});
            if (
                typeof serverModule.app !== 'function' ||
                typeof serverModule.startServer !== 'function' ||
                typeof serverModule.closeDatabase !== 'function'
            ) {
                throw new Error('invalid compiled server exports');
            }
            await serverModule.closeDatabase();
        })().catch(error => {
            console.error(error);
            process.exitCode = 1;
        });
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
        cwd: os.tmpdir(),
        env: isolatedServerEnv('load-from-temp-cwd'),
        encoding: 'utf8',
        timeout: 5000
    });

    assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('legacy server entry forwards the compiled lifecycle contract', () => {
    const compiled = require(SERVER_ENTRY);
    const legacy = require(LEGACY_SERVER_ENTRY);

    assert.equal(legacy.app, compiled.app);
    assert.equal(legacy.startServer, compiled.startServer);
    assert.equal(legacy.closeDatabase, compiled.closeDatabase);
});

test('news publishing does not write an audit record when user lookup fails', async () => {
    const token = await getOpToken();
    const beforeRow = await get(
        fixturePool,
        "SELECT COUNT(*)::integer AS total FROM logs WHERE action='发布新闻'"
    );
    await run(fixturePool, "DELETE FROM users WHERE username='security-test-op'");

    const response = await fetch(`${baseUrl}/api/admin/news`, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json'
        },
        body: JSON.stringify({
            title: 'missing-user-audit-check',
            content: 'https://example.com/news'
        })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
        success: false,
        msg: '用户信息获取失败'
    });

    const afterRow = await get(
        fixturePool,
        "SELECT COUNT(*)::integer AS total FROM logs WHERE action='发布新闻'"
    );
    assert.equal(afterRow.total, beforeRow.total);
});

test('production refuses to load without IMS_BACKOFFICE_JWT_SECRET', () => {
    const script = `require(${JSON.stringify(SERVER_ENTRY)})`;
    const env = { ...process.env, NODE_ENV: 'production' };
    delete env.IMS_BACKOFFICE_JWT_SECRET;
    delete env.IMS_JWT_SECRET;

    const result = spawnSync(process.execPath, ['-e', script], {
        cwd: os.tmpdir(),
        env,
        encoding: 'utf8'
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /IMS_BACKOFFICE_JWT_SECRET is required/);
});

test('production NODE_ENV is normalized before fail-fast checks', () => {
    const env = { ...process.env, NODE_ENV: ' Production ' };
    delete env.IMS_BACKOFFICE_JWT_SECRET;
    delete env.IMS_JWT_SECRET;
    const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(SERVER_ENTRY)})`], {
        cwd: os.tmpdir(),
        env,
        encoding: 'utf8'
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /IMS_BACKOFFICE_JWT_SECRET is required/);
});

test('unknown NODE_ENV values fail fast', () => {
    const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(SERVER_ENTRY)})`], {
        cwd: os.tmpdir(),
        env: { ...process.env, NODE_ENV: 'stagin' },
        encoding: 'utf8'
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /NODE_ENV must be/);
});

test('production refuses a short IMS_BACKOFFICE_JWT_SECRET', () => {
    const script = `require(${JSON.stringify(SERVER_ENTRY)})`;
    const env = {
        ...process.env,
        NODE_ENV: 'production',
        IMS_BACKOFFICE_JWT_SECRET: 'too-short'
    };

    const result = spawnSync(process.execPath, ['-e', script], {
        cwd: os.tmpdir(),
        env,
        encoding: 'utf8'
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /at least 32 UTF-8 bytes/);
});

test('production JWT secret length is measured in UTF-8 bytes', () => {
    const script = `const server = require(${JSON.stringify(SERVER_ENTRY)}); server.closeDatabase()`;
    const env = {
        ...process.env,
        NODE_ENV: 'production',
        IMS_BACKOFFICE_JWT_SECRET: '😀'.repeat(8),
        IMS_PLATFORM_JWT_SECRET: '平台'.repeat(6),
        DATABASE_URL: databaseUrl,
        IMS_EVENT_BASE_DIR: path.join(tempDir, 'utf8-secret-events')
    };
    const result = spawnSync(process.execPath, ['-e', script], {
        cwd: os.tmpdir(),
        env,
        encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
});
