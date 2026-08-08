'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
    assignedJson,
    buildIdolIndex,
    canonicalAssetUrl,
    extractCssReferences,
    extractHtmlReferences,
    mapAssetUrl,
    parseArguments,
    runWikiMediaSync,
    safeObjectKey
} = require('../../scripts/migration/wiki-media-sync');

const origin = 'https://idol-master.top';
const idolIndex = buildIdolIndex([{
    agency_code: 'sc',
    agency_name: '闪耀色彩',
    idol_name: '樱木真乃',
    folder_name: 'sakuragi_mano'
}]);

test('Wiki media sync accepts pnpm forwarded argument separators', () => {
    const options = parseArguments(['--', '--help']);
    assert.equal(options.help, true);
});

test('Wiki media sync no longer accepts a SQLite database option', () => {
    const options = parseArguments([], {
        IMS_SQLITE_PATH: '/tmp/imsweb.db',
        IMS_STORY_DB_PATH: '/tmp/legacy-story.db'
    });
    assert.equal(Object.hasOwn(options, 'database'), false);
    assert.throws(
        () => parseArguments(['--database', '/tmp/imsweb.db']),
        /Unknown argument: --database/
    );
});

test('Wiki media crawl opens only the story repository when upload is disabled', async () => {
    const calls = [];
    const storyRepository = {
        listIdolsWithAgencies: async () => [{
            agency_code: 'sc',
            agency_name: '闪耀色彩',
            name_cn: '樱木真乃',
            folder_name: 'sakuragi_mano'
        }],
        close: async () => calls.push('close-story')
    };
    const manifest = await runWikiMediaSync(
        { upload: false, uploadExisting: false },
        {
            openStoryRepository: async () => {
                calls.push('open-story');
                return storyRepository;
            },
            resolveStorage: async () => {
                calls.push('resolve-storage');
                throw new Error('storage must not be initialized');
            },
            closeStorage: async () => calls.push('close-storage'),
            syncWikiMedia: async (_options, index, storage) => {
                calls.push('crawl');
                assert.equal(index.size, 1);
                assert.equal(storage, undefined);
                return { complete: true, summary: { assetCount: 0 } };
            }
        }
    );

    assert.equal(manifest.complete, true);
    assert.deepEqual(calls, ['open-story', 'crawl', 'close-story']);
});

test('Wiki media upload reuses storage and closes resources after failure', async () => {
    const calls = [];
    const storage = { name: 'test-storage' };
    const storyRepository = {
        listIdolsWithAgencies: async () => [{
            agency_code: 'sc',
            agency_name: '闪耀色彩',
            name_cn: '樱木真乃',
            folder_name: 'sakuragi_mano'
        }],
        close: async () => calls.push('close-story')
    };

    await assert.rejects(
        runWikiMediaSync(
            { upload: true, uploadExisting: false },
            {
                openStoryRepository: async () => storyRepository,
                resolveStorage: async () => {
                    calls.push('resolve-storage');
                    return storage;
                },
                closeStorage: async () => calls.push('close-storage'),
                syncWikiMedia: async (_options, _index, receivedStorage) => {
                    calls.push('crawl');
                    assert.equal(receivedStorage, storage);
                    throw new Error('crawl failed');
                }
            }
        ),
        /crawl failed/
    );
    assert.deepEqual(calls, [
        'resolve-storage',
        'crawl',
        'close-story',
        'close-storage'
    ]);
});

test('Wiki media sync maps source paths to stable business object keys', () => {
    assert.deepEqual(
        mapAssetUrl(
            'https://idol-master.top/image/%E9%97%AA%E8%80%80%E8%89%B2%E5%BD%A9/%E6%A8%B1%E6%9C%A8%E7%9C%9F%E4%B9%83/card/card_1.webp',
            idolIndex
        ),
        {
            kind: 'story-media',
            agencyCode: 'sc',
            agencyName: '闪耀色彩',
            idolName: '樱木真乃',
            folderName: 'sakuragi_mano',
            relativePath: 'card/card_1.webp',
            objectKey: 'wiki/agencies/sc/idols/sakuragi_mano/story-images/card/card_1.webp'
        }
    );
    assert.equal(
        mapAssetUrl(
            'https://idol-master.top/image/%E9%97%AA%E8%80%80%E8%89%B2%E5%BD%A9/%E6%A8%B1%E6%9C%A8%E7%9C%9F%E4%B9%83/icon.webp',
            idolIndex
        ).objectKey,
        'wiki/agencies/sc/idols/sakuragi_mano/avatar.webp'
    );
    assert.equal(
        mapAssetUrl('https://idol-master.top/icon/sc/wing.webp', idolIndex).objectKey,
        'wiki/shared/static/icon/sc/wing.webp'
    );
    assert.equal(
        mapAssetUrl('https://idol-master.top/css/story.css?v=38', idolIndex).objectKey,
        'wiki/shared/static/css/story.css'
    );
    assert.equal(
        mapAssetUrl('https://idol-master.top/icon/agencies/sc.webp', idolIndex).objectKey,
        'wiki/agencies/sc/branding/icon.webp'
    );
    assert.throws(
        () => mapAssetUrl('https://idol-master.top/image/闪耀色彩/不存在/icon.webp', idolIndex),
        /no local agency\/idol mapping/
    );
    assert.throws(() => safeObjectKey(['wiki', '..', 'secret']), /Unsafe object-key segment/);
});

test('Wiki media sync extracts story, DOM, inline CSS, and storyData assets', async () => {
    const { parse } = await import('parse5');
    const storyData = JSON.stringify([{
        cards: [{ img: '/image/闪耀色彩/樱木真乃/card/card_2.webp' }]
    }]);
    const html = `<!doctype html>
        <a href="/story?agency=闪耀色彩&idol=樱木真乃">story</a>
        <img src="/image/闪耀色彩/樱木真乃/icon.webp">
        <div style="background-image:url('/icon/sc.webp')"></div>
        <style>.hero{background:url('/assets/images/hero.png')}</style>
        <script>window.storyData = ${storyData};</script>`;
    const result = extractHtmlReferences(html, `${origin}/wiki/`, origin, parse);
    assert.equal(result.stories.size, 1);
    assert.deepEqual(
        [...result.assets].map((url) => decodeURIComponent(new URL(url).pathname)).sort(),
        [
            '/assets/images/hero.png',
            '/icon/sc.webp',
            '/image/闪耀色彩/樱木真乃/card/card_2.webp',
            '/image/闪耀色彩/樱木真乃/icon.webp'
        ].sort()
    );
    assert.deepEqual(assignedJson(`window.storyData = ${storyData};`, 'window.storyData'), [
        { cards: [{ img: '/image/闪耀色彩/樱木真乃/card/card_2.webp' }] }
    ]);
});

test('Wiki media sync keeps extraction same-origin and resolves CSS-relative paths', () => {
    assert.equal(
        canonicalAssetUrl('../icon/sc.webp?v=1#ignored', `${origin}/css/main.css`, origin),
        `${origin}/icon/sc.webp`
    );
    assert.equal(canonicalAssetUrl('https://example.com/image.webp', `${origin}/wiki/`, origin), null);
    assert.deepEqual(
        [...extractCssReferences(
            '@import "./theme.css"; .a{background:url(../icon/sc.webp)}',
            `${origin}/css/main.css`,
            origin
        )].sort(),
        [`${origin}/css/theme.css`, `${origin}/icon/sc.webp`]
    );
});
