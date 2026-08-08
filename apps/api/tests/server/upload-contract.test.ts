import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import sharp from 'sharp';
import { StreamingUploadParser } from '@/infra/http/busboy/upload-parser';
import { SharpImageProcessor } from '@/infra/media/sharp/image-processor';
import type { ImageInfo, ImageProcessor } from '@/ports/media';
import type { UploadParser } from '@/ports/http';
import { validateUploadedImage } from '@/utils/media/image-upload';
import { md5Hex } from '@/utils/crypto/md5';

function versionAtLeast(actual: string, minimum: readonly number[]): boolean {
    const parts = actual.split('.').map(Number);
    for (const [index, part] of minimum.entries()) {
        if ((parts[index] ?? 0) > part) return true;
        if ((parts[index] ?? 0) < part) return false;
    }
    return true;
}

class FixtureImages implements ImageProcessor {
    constructor(private readonly format = 'png', private readonly broken = false) {}
    async validate(): Promise<ImageInfo> {
        if (this.broken) throw new Error('decode failed');
        return { format: this.format, width: 1, height: 1, contentType: `image/${this.format}` };
    }
    async toWebp(body: Uint8Array) { return body; }
    async thumbnailPng(body: Uint8Array) { return body; }
    async resizeJpeg(body: Uint8Array) { return body; }
}

async function materializedMultipartRequest(form: FormData): Promise<Request> {
    const encoded = new Request('http://ims.test/upload', { method: 'POST', body: form });
    const contentType = encoded.headers.get('content-type');
    assert.ok(contentType);
    const body = await encoded.arrayBuffer();
    return new Request('http://ims.test/upload', {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body
    });
}

for (const [name, parser] of [
    ['Node streaming', new StreamingUploadParser()]
] as const) {
    test(`${name} multipart parser counts unknown files against the file limit without Content-Length`, async () => {
        const form = new FormData();
        form.append('known', new Blob(['a'], { type: 'text/plain' }), 'a.txt');
        form.append('unknown', new Blob(['b'], { type: 'text/plain' }), 'b.txt');
        const request = await materializedMultipartRequest(form);
        assert.equal(request.headers.get('content-length'), null);
        await assert.rejects(parser.parse(request, {
            maxBytes: 4096,
            fileFields: ['known'],
            maxFiles: 1,
            maxFields: 2,
            maxParts: 3
        }), (error: Error & { status?: number }) => error.status === 413);
    });

    test(`${name} multipart parser accepts exactly the configured part limit`, async () => {
        const form = new FormData();
        form.append(
            'image',
            new Blob([new Uint8Array(137 * 1024)], { type: 'image/png' }),
            'avatar.png'
        );
        const request = await materializedMultipartRequest(form);
        const parsed = await parser.parse(request, {
            maxBytes: 256 * 1024,
            fileFields: ['image'],
            maxFiles: 1,
            maxFields: 0,
            maxParts: 1
        });
        const image = parsed.files.image;
        assert.ok(image && !Array.isArray(image));
        assert.equal(image.body.byteLength, 137 * 1024);
    });

    test(`${name} multipart parser rejects one part beyond the configured limit`, async () => {
        const form = new FormData();
        form.append('image', new Blob(['a'], { type: 'image/png' }), 'a.png');
        form.append('image', new Blob(['b'], { type: 'image/png' }), 'b.png');
        const request = await materializedMultipartRequest(form);
        await assert.rejects(parser.parse(request, {
            maxBytes: 4096,
            fileFields: ['image'],
            maxFiles: 2,
            maxFields: 0,
            maxParts: 1
        }), (error: Error & { status?: number }) =>
            error.status === 413 && error.message === 'multipart parts exceed limit'
        );
    });

    test(`${name} multipart parser rejects raw boundary overhead at maxBytes + 1`, async () => {
        const boundary = 'ims-boundary';
        const body = new Uint8Array(65);
        const request = new Request('http://ims.test/upload', {
            method: 'POST',
            headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
            body
        });
        await assert.rejects(parser.parse(request, {
            maxBytes: 64,
            fileFields: ['image']
        }), (error: Error & { status?: number }) => error.status === 413);
    });

    test(`${name} multipart parser accepts exactly maxParts and rejects the next part`, async () => {
        const exact = new FormData();
        exact.append('expectedRevision', '1');
        exact.append('image', new Blob(['image'], { type: 'text/plain' }), 'image.txt');
        const parsed = await parser.parse(await materializedMultipartRequest(exact), {
            maxBytes: 4096,
            fileFields: ['image'],
            maxFiles: 1,
            maxFields: 1,
            maxParts: 2
        });
        assert.equal(parsed.fields.expectedRevision, '1');
        assert.equal(Array.isArray(parsed.files.image), false);

        const extra = new FormData();
        extra.append('expectedRevision', '1');
        extra.append('cardId', 'card-1');
        extra.append('image', new Blob(['image'], { type: 'text/plain' }), 'image.txt');
        await assert.rejects(parser.parse(await materializedMultipartRequest(extra), {
            maxBytes: 4096,
            fileFields: ['image'],
            maxFiles: 1,
            maxFields: 3,
            maxParts: 2
        }), (error: Error & { status?: number }) => error.status === 413);
    });

    test(`${name} multipart parser reports interrupted bodies`, async () => {
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('--broken\r\n'));
                controller.error(new Error('connection reset'));
            }
        });
        const request = new Request('http://ims.test/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'multipart/form-data; boundary=broken' },
            body,
            duplex: 'half'
        } as RequestInit & { duplex: 'half' });
        await assert.rejects(parser.parse(request, {
            maxBytes: 4096,
            fileFields: ['image']
        }));
    });
}

test('shared image upload contract rejects extension, MIME, decoded format, and corrupt payload mismatches', async () => {
    const body = new Uint8Array([1, 2, 3]);
    await assert.rejects(validateUploadedImage(
        { filename: 'payload.txt', contentType: 'text/plain', body }, new FixtureImages()
    ), /图片格式不支持/);
    await assert.rejects(validateUploadedImage(
        { filename: 'payload.jpg', contentType: 'image/png', body }, new FixtureImages()
    ), /扩展名与 MIME/);
    await assert.rejects(validateUploadedImage(
        { filename: 'payload.png', contentType: 'image/png', body }, new FixtureImages('jpeg')
    ), /内容与文件格式/);
    await assert.rejects(validateUploadedImage(
        { filename: 'payload.png', contentType: 'image/png', body }, new FixtureImages('png', true)
    ), /损坏或无法解码/);
    assert.equal((await validateUploadedImage(
        { filename: 'payload.jfif', contentType: 'image/pjpeg', body }, new FixtureImages('jpeg')
    )).format, 'jpeg');
});

test('Sharp runtime includes the libvips fixes for inherited image decoder CVEs', () => {
    assert.ok(versionAtLeast(sharp.versions.sharp, [0, 35, 0]), sharp.versions.sharp);
    assert.ok(versionAtLeast(sharp.versions.vips, [8, 18, 3]), sharp.versions.vips);
});

test('Sharp image processor validates and converts real image bytes with stable dimensions', async () => {
    const processor = new SharpImageProcessor();
    const source = await sharp({
        create: {
            width: 8,
            height: 4,
            channels: 3,
            background: { r: 120, g: 40, b: 200 }
        }
    }).png().toBuffer();

    assert.deepEqual(await processor.validate(source, 'image/png'), {
        format: 'png',
        width: 8,
        height: 4,
        contentType: 'image/png'
    });
    for (const [format, contentType, declaredType, encoded] of [
        ['gif', 'image/gif', 'image/gif', await sharp(source).gif().toBuffer()],
        ['tiff', 'image/tiff', undefined, await sharp(source).tiff().toBuffer()]
    ] as const) {
        assert.deepEqual(await processor.validate(encoded, declaredType), {
            format,
            width: 8,
            height: 4,
            contentType
        });
    }
    await assert.rejects(processor.validate(source, 'image/jpeg'), /图片类型与内容不匹配/);
    await assert.rejects(processor.validate(Uint8Array.of(1, 2, 3)), /unsupported image format|Input buffer/);

    const webp = await sharp(await processor.toWebp(source, 82)).metadata();
    assert.deepEqual({ format: webp.format, width: webp.width, height: webp.height }, {
        format: 'webp', width: 8, height: 4
    });
    const thumbnail = await sharp(await processor.thumbnailPng(source, 3, 3)).metadata();
    assert.deepEqual({ format: thumbnail.format, width: thumbnail.width, height: thumbnail.height }, {
        format: 'png', width: 3, height: 3
    });
    const jpeg = await sharp(await processor.resizeJpeg(source, 20, 20)).metadata();
    assert.deepEqual({ format: jpeg.format, width: jpeg.width, height: jpeg.height }, {
        format: 'jpeg', width: 8, height: 4
    });
});

test('shared MD5 implementation matches RFC vectors and legacy Node hashes', () => {
    for (const value of ['', 'a', 'abc', 'message digest', 'IMS WebP bytes']) {
        const bytes = new TextEncoder().encode(value);
        assert.equal(md5Hex(bytes), crypto.createHash('md5').update(bytes).digest('hex'));
    }
});
