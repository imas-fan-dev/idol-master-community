import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createWikiFixture, type WikiFixture } from './fixture';

async function postBilibili(fixture: WikiFixture, input: string) {
    return fixture.app.request('/api/wiki/parse_bilibili', {
        method: 'POST',
        headers: {
            ...await fixture.authHeaders('editor'),
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ url: input })
    });
}

describe('WIKI-02 isolated Bilibili parsing contract', () => {
    test('fake video fetch receives the API URL, user agent and abort signal', async () => {
        const fixture = createWikiFixture();
        let requestedUrl = '';
        let requestedInit: RequestInit | undefined;
        fixture.setFetch((async (input, init) => {
            requestedUrl = String(input);
            requestedInit = init;
            return new Response(JSON.stringify({
                code: 0,
                data: {
                    bvid: 'BV1xx411c7mD',
                    title: '合集标题',
                    pic: 'http://i0.hdslb.com/bfs/archive/cover.jpg#fragment',
                    owner: { name: '测试UP' },
                    pages: [
                        { page: 1, part: '第一话' },
                        { page: 2, part: '第二话' }
                    ]
                }
            }), { headers: { 'Content-Type': 'application/json' } });
        }) as typeof globalThis.fetch);

        const response = await postBilibili(fixture, 'https://www.bilibili.com/video/BV1xx411c7mD?p=2');
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {
            status: 'success',
            title: '第二话',
            up: '测试UP',
            std_url: 'https://www.bilibili.com/video/BV1xx411c7mD?p=2',
            cover_url: 'https://i0.hdslb.com/bfs/archive/cover.jpg'
        });
        assert.equal(requestedUrl, 'https://api.bilibili.com/x/web-interface/view?bvid=BV1xx411c7mD');
        assert.equal(new Headers(requestedInit?.headers).get('user-agent'), 'Mozilla/5.0');
        assert.ok(requestedInit?.signal instanceof AbortSignal);
        assert.equal(requestedInit?.signal?.aborted, false);
    });

    test('invalid input skips fetch and upstream errors preserve compatible JSON', async () => {
        const invalidFixture = createWikiFixture();
        let calls = 0;
        invalidFixture.setFetch((async () => {
            calls += 1;
            throw new Error('must not be called');
        }) as typeof globalThis.fetch);
        const invalid = await postBilibili(invalidFixture, 'not a Bilibili identifier');
        assert.equal(invalid.status, 200);
        assert.deepEqual(await invalid.json(), {
            status: 'error',
            msg: '未检测到有效的 BV号/av号/收藏夹链接'
        });
        assert.equal(calls, 0);

        const upstreamFixture = createWikiFixture();
        upstreamFixture.setFetch((async (_input, init) => {
            assert.ok(init?.signal instanceof AbortSignal);
            return new Response(JSON.stringify({ code: -400, message: '请求错误' }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }) as typeof globalThis.fetch);
        const upstream = await postBilibili(upstreamFixture, 'BV1xx411c7mD');
        assert.equal(upstream.status, 200);
        assert.deepEqual(await upstream.json(), { status: 'error', msg: '请求错误' });
    });

    test('the five-second timeout aborts injected fetch and maps to the legacy gateway error', async (context) => {
        context.mock.timers.enable({ apis: ['setTimeout'] });
        const fixture = createWikiFixture();
        let signalFetchStarted!: (signal: AbortSignal) => void;
        const fetchStarted = new Promise<AbortSignal>((resolve) => {
            signalFetchStarted = resolve;
        });
        fixture.setFetch((async (_input, init) => {
            const signal = init?.signal;
            assert.ok(signal instanceof AbortSignal);
            signalFetchStarted(signal);
            return new Promise<Response>((_resolve, reject) => {
                signal.addEventListener(
                    'abort',
                    () => reject(new DOMException('aborted', 'AbortError')),
                    { once: true }
                );
            });
        }) as typeof globalThis.fetch);

        const pending = postBilibili(fixture, 'BV1xx411c7mD');
        const signal = await fetchStarted;
        assert.equal(signal.aborted, false);
        context.mock.timers.tick(4999);
        assert.equal(signal.aborted, false);
        context.mock.timers.tick(1);
        assert.equal(signal.aborted, true);

        const response = await pending;
        assert.equal(response.status, 502);
        assert.deepEqual(await response.json(), { status: 'error', msg: '解析请求失败' });
    });
});
