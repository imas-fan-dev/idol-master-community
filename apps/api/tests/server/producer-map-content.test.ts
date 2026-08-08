import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHonoApp } from '@/app';
import { defaultProducerMapContent } from '@/domains/producer-map/data';
import { producerMapAssetObjectKey } from '@/utils/storage/business-object-keys';
import type {
    ListedObject,
    ObjectStorage,
    PutObjectOptions,
    StoredObject
} from '@/ports/object-storage';
import type { AuditLogInput } from '@/ports/repositories';
import type { RuntimeServices } from '@/ports/runtime-services';

class MemoryStorage implements ObjectStorage {
    private readonly objects = new Map<string, StoredObject>();
    private revision = 0;

    async get(key: string): Promise<StoredObject | null> {
        const object = this.objects.get(key);
        return object ? { ...object, body: Uint8Array.from(object.body) } : null;
    }

    async put(
        key: string,
        body: Uint8Array,
        options: PutObjectOptions = {}
    ): Promise<StoredObject> {
        this.revision += 1;
        const object = {
            body: Uint8Array.from(body),
            size: body.byteLength,
            contentType: options.contentType || 'application/octet-stream',
            etag: `"revision-${this.revision}"`
        };
        this.objects.set(key, object);
        return { ...object, body: Uint8Array.from(object.body) };
    }

    async putIfUnchanged(
        key: string,
        expectedEtag: string | null,
        body: Uint8Array,
        options: PutObjectOptions = {}
    ): Promise<StoredObject | null> {
        if ((this.objects.get(key)?.etag ?? null) !== expectedEtag) return null;
        return this.put(key, body, options);
    }

    async delete(key: string): Promise<void> { this.objects.delete(key); }
    async exists(key: string): Promise<boolean> { return this.objects.has(key); }
    async copy(sourceKey: string, destinationKey: string): Promise<void> {
        const source = await this.get(sourceKey);
        if (!source) throw new Error('source missing');
        await this.put(destinationKey, source.body, { contentType: source.contentType });
    }
    async move(sourceKey: string, destinationKey: string): Promise<void> {
        await this.copy(sourceKey, destinationKey);
        await this.delete(sourceKey);
    }
    async list(prefix: string): Promise<ListedObject[]> {
        return [...this.objects.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, value]) => ({ key, size: value.size, etag: value.etag }));
    }
    async deletePrefix(prefix: string): Promise<void> {
        for (const key of this.objects.keys()) {
            if (key.startsWith(prefix)) this.objects.delete(key);
        }
    }
}

function fixture() {
    const storage = new MemoryStorage();
    const audit: AuditLogInput[] = [];
    const services: RuntimeServices = {
        storage,
        audit: {
            async insertAuditLog(input) { audit.push(input); },
            async listRecentAuditLogs() { return []; }
        },
        backofficeTokens: {
            async sign() { return 'producer-map-token'; },
            async verify() {
                return {
                    id: 1,
                    username: 'map-editor',
                    producername: 'Map Producer',
                    dept: 'op',
                    csrfSecret: 'producer-map-csrf'
                };
            }
        }
    };
    const app = createHonoApp(() => services);
    const request = (path: string, init?: RequestInit) =>
        app.request(`http://ims.test${path}`, init);
    return { request, audit, storage };
}

test('producer map media is served from semantic object storage', async () => {
    const { request, storage } = fixture();
    const body = Uint8Array.from([137, 80, 78, 71]);
    await storage.put(producerMapAssetObjectKey('community-u149.png'), body, {
        contentType: 'image/png'
    });

    const response = await request('/uploads/producer-map/community-u149.png');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(
        response.headers.get('cache-control'),
        'public, max-age=31536000, immutable'
    );
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), body);

    const head = await request('/uploads/producer-map/community-u149.png', {
        method: 'HEAD'
    });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(body.byteLength));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal((await request('/uploads/producer-map/missing.png')).status, 404);
});

test('producer map exposes migrated public defaults without legacy media', async () => {
    const { request } = fixture();
    const response = await request('/api/producer-map');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    const content = await response.json() as ReturnType<typeof defaultProducerMapContent>;
    assert.equal(content.title, '全国偶像大师社群一览');
    assert.equal(content.communities.length, 9);
    assert.deepEqual(content.communities.slice(0, 2).map((item) => item.name), [
        '站长小窝',
        '大部分都能唠些的闪耀色彩群'
    ]);
    assert.ok(content.communities.every((item) => item.imageUrl === null));
});

test('producer map admin updates are authenticated, audited, and revision guarded', async () => {
    const { request, audit } = fixture();
    assert.equal((await request('/api/admin/producer-map')).status, 401);

    const headers = {
        Authorization: 'Bearer producer-map-token',
        'Content-Type': 'application/json'
    };
    const initialResponse = await request('/api/admin/producer-map', { headers });
    assert.equal(initialResponse.status, 200);
    const initial = await initialResponse.json() as {
        content: ReturnType<typeof defaultProducerMapContent>;
        revision: string | null;
    };
    const edited = {
        ...initial.content,
        introduction: '更新后的全国制作人社群入口。',
        regions: [
            {
                id: 'guangdong',
                province: '广东省',
                name: '广东制作人社群',
                summary: '珠三角与粤东西北制作人交流信息。',
                contact: '公开联系信息',
                linkUrl: 'https://example.com/guangdong',
                imageUrl: '/maps/guangdong-contact.png',
                series: 'all' as const,
                enabled: true
            }
        ]
    };
    const savedResponse = await request('/api/admin/producer-map', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ content: edited, revision: initial.revision })
    });
    assert.equal(savedResponse.status, 200);
    const saved = await savedResponse.json() as {
        content: ReturnType<typeof defaultProducerMapContent>;
        revision: string;
    };
    assert.match(saved.revision, /revision-1/);
    assert.equal(saved.content.regions[0]?.province, '广东省');
    assert.ok(saved.content.updatedAt);
    assert.equal(audit.at(-1)?.action, '更新制作人地图');

    const publicContent = await (await request('/api/producer-map')).json() as typeof saved.content;
    assert.equal(publicContent.introduction, edited.introduction);

    const stale = await request('/api/admin/producer-map', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ content: edited, revision: null })
    });
    assert.equal(stale.status, 409);
    assert.match((await stale.json() as { error: string }).error, /刷新后重试/);
});

test('producer map rejects unsafe links and duplicate provinces', async () => {
    const { request } = fixture();
    const headers = {
        Authorization: 'Bearer producer-map-token',
        'Content-Type': 'application/json'
    };
    const unsafe = defaultProducerMapContent();
    unsafe.communities[0]!.linkUrl = 'javascript:alert(1)';
    const unsafeResponse = await request('/api/admin/producer-map', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ content: unsafe, revision: null })
    });
    assert.equal(unsafeResponse.status, 400);
    assert.match((await unsafeResponse.json() as { error: string }).error, /链接无效/);

    const duplicate = defaultProducerMapContent();
    duplicate.regions = [
        {
            id: 'guangdong-a',
            province: '广东省',
            name: '广东 A',
            summary: '',
            contact: '',
            linkUrl: null,
            imageUrl: null,
            series: 'all',
            enabled: true
        },
        {
            id: 'guangdong-b',
            province: '广东省',
            name: '广东 B',
            summary: '',
            contact: '',
            linkUrl: null,
            imageUrl: null,
            series: 'all',
            enabled: true
        }
    ];
    const duplicateResponse = await request('/api/admin/producer-map', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ content: duplicate, revision: null })
    });
    assert.equal(duplicateResponse.status, 400);
    assert.match((await duplicateResponse.json() as { error: string }).error, /行政区不能重复/);
});
