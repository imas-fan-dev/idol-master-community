'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
    LEGACY_INFORMATION_CARDS,
    nextInformationIndex,
    parseArguments,
    syncLegacyInformation
} = require('../../scripts/migration/legacy-information-media');

class MemoryStorage {
    constructor() {
        this.objects = new Map();
        this.revision = 0;
    }

    async get(key) {
        const value = this.objects.get(key);
        return value ? { ...value, body: Uint8Array.from(value.body) } : null;
    }

    async put(key, body, options = {}) {
        const stored = {
            body: Uint8Array.from(body),
            size: body.byteLength,
            contentType: options.contentType || 'application/octet-stream',
            etag: `"revision-${++this.revision}"`
        };
        this.objects.set(key, stored);
        return stored;
    }

    async putIfUnchanged(key, expectedEtag, body, options = {}) {
        const current = this.objects.get(key);
        if ((expectedEtag === null && current) ||
            (expectedEtag !== null && current?.etag !== expectedEtag)) {
            return null;
        }
        return this.put(key, body, options);
    }
}

async function sourceFixture(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ims-information-migration-'));
    for (const seed of LEGACY_INFORMATION_CARDS) {
        const target = path.join(directory, seed.source);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, `image:${seed.id}`);
    }
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return directory;
}

test('legacy Information migration is read-only unless apply is explicit', () => {
    const options = parseArguments(['--', '--source', './public']);
    assert.equal(options.apply, false);
    assert.equal(options.source, path.resolve('./public'));
    assert.equal(parseArguments(['--apply']).apply, true);
    assert.throws(() => parseArguments(['--source']), /requires a value/);
});

test('legacy Information migration converts static cards without replacing admin records', () => {
    const adminCard = {
        id: 'info-admin-001',
        category: 'activity',
        contentType: 'external',
        title: 'Admin card',
        image: '/uploads/information/original/admin.webp',
        link: 'https://example.com/admin',
        updatedAt: '2026-07-24T01:00:00.000Z'
    };
    const staticLegacyCard = {
        id: 'legacy-hiro2026',
        category: 'activity',
        contentType: 'external',
        title: 'Edited legacy title',
        image: '/assets/images/hiro2026/xzg2026.png',
        link: '/edited',
        updatedAt: '2026-07-23T00:00:00.000Z'
    };
    const plan = nextInformationIndex({
        version: 1,
        cards: [adminCard, staticLegacyCard],
        assets: [adminCard.image]
    });
    assert.equal(plan.convertedCards, 1);
    assert.equal(plan.addedCards, 5);
    assert.deepEqual(plan.index.cards[0], adminCard);
    assert.equal(plan.index.cards[1].title, 'Edited legacy title');
    assert.equal(
        plan.index.cards[1].image,
        '/uploads/information/original/xzg2026.png'
    );
    assert.equal(plan.index.cards[1].link, '/edited');
});

test('legacy Information migration upgrades only the retired hiro page link', () => {
    const plan = nextInformationIndex({
        version: 1,
        cards: [{
            id: 'legacy-hiro2026',
            category: 'activity',
            contentType: 'external',
            title: '管理员保留的标题',
            image: '/uploads/information/original/xzg2026.png',
            link: '/hiro2026.html',
            updatedAt: '2026-07-23T00:00:00.000Z'
        }],
        assets: ['/uploads/information/original/xzg2026.png']
    });

    assert.equal(plan.convertedCards, 1);
    assert.equal(plan.index.cards[0].title, '管理员保留的标题');
    assert.equal(plan.index.cards[0].link, '/sites/hiro2026');
});

test('legacy Information migration writes and verifies six images plus one stored index', async (t) => {
    const source = await sourceFixture(t);
    const storage = new MemoryStorage();

    const audit = await syncLegacyInformation(source, storage, false);
    assert.equal(audit.cardsAdded, 6);
    assert.equal(audit.summary.wouldUpload, 6);
    assert.equal(storage.objects.size, 0);

    const applied = await syncLegacyInformation(source, storage, true);
    assert.equal(applied.indexStatus, 'created');
    assert.equal(applied.summary.uploaded, 6);
    assert.equal(storage.objects.size, 7);
    const index = JSON.parse(Buffer.from(
        storage.objects.get('editorial/information/index.json').body
    ).toString('utf8'));
    assert.equal(index.cards.length, 6);
    assert.equal(index.assets.length, 6);
    assert.ok(index.cards.every((card) => card.image.startsWith('/uploads/information/')));
    assert.equal(
        index.cards.find((card) => card.id === 'legacy-hiro2026').link,
        '/sites/hiro2026'
    );
    assert.equal(
        index.cards.find((card) => card.id === 'legacy-guangzhou2026').link,
        'https://show.bilibili.com/platform/detail.html?id=1002732&from=pc_search'
    );

    const repeated = await syncLegacyInformation(source, storage, true);
    assert.equal(repeated.indexStatus, 'unchanged');
    assert.equal(repeated.cardsAdded, 0);
    assert.equal(repeated.summary.unchanged, 6);
    assert.equal(storage.objects.size, 7);

    const replacement = '/uploads/information/original/admin-replacement.png';
    index.cards[0].image = replacement;
    index.assets.push(replacement);
    await storage.put(
        'editorial/information/assets/admin-replacement/cover.png',
        Buffer.from('replacement')
    );
    await storage.put(
        'editorial/information/index.json',
        Buffer.from(JSON.stringify(index)),
        { contentType: 'application/json; charset=utf-8' }
    );

    const administratorEdited = await syncLegacyInformation(source, storage, true);
    assert.equal(administratorEdited.indexStatus, 'unchanged');
    assert.equal(administratorEdited.cardsConverted, 0);
});
