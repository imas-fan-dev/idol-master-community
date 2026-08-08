import type { Context } from 'hono';
import type { AppEnvironment } from '@/app';
import { writeAudit } from '@/domains/audit/hono-service';
import { parseNewsSubmission } from '@/domains/news/submission';
import { randomHex } from '@/utils/crypto/random';
import { messageFromError, statusFromError } from '@/utils/http/error-response';
import {
    backofficeAuthRepository,
    newsRepository,
    services
} from '@/middleware/hono-context';
import { fetchBilibiliCover } from '@/utils/media/bilibili-cover';
import { safeUploadBaseName } from '@/utils/media/filename';
import { validateUploadedImage } from '@/utils/media/image-upload';
import { deleteObjectWithCompensation } from '@/utils/storage/delete-object';
import {
    newsOriginalObjectKey,
    newsThumbnailObjectKey
} from '@/utils/storage/business-object-keys';

export async function handleCreateNews(c: Context<AppEnvironment>): Promise<Response> {
    const runtime = services(c);
    let originalKey = '';
    let thumbnailKey = '';
    let originalPublicKey = '';
    let thumbnailPublicKey = '';
    let businessCommitted = false;
    try {
        const submission = await parseNewsSubmission(c);
        let url: URL;
        try {
            url = new URL(String(submission.content || ''));
        } catch {
            return c.json({ success: false, msg: '资讯链接无效' }, 400);
        }
        if (
            typeof submission.title !== 'string' || !submission.title.trim() ||
            submission.title.length > 300 || !['http:', 'https:'].includes(url.protocol) ||
            url.href.length > 4096
        ) {
            return c.json({ success: false, msg: '资讯标题或链接无效' }, 400);
        }

        let imageFile = submission.file;
        if (!imageFile && submission.coverUrl) {
            if (!runtime.fetch) throw new Error('Fetch service unavailable');
            imageFile = await fetchBilibiliCover(submission.coverUrl, runtime.fetch);
        }

        if (imageFile) {
            if (!runtime.images || !runtime.storage) throw new Error('Image services unavailable');
            if (imageFile.body.byteLength > 10 * 1024 * 1024) {
                return c.json({ success: false, msg: '图片过大' }, 400);
            }
            const info = await validateUploadedImage(imageFile, runtime.images);
            const extension = info.format === 'jpeg' ? 'jpg' : info.format;
            const filename = `${safeUploadBaseName(imageFile.filename)}-${Date.now()}-${randomHex(6)}.${extension}`;
            const thumbnailName = filename.replace('.', '_thumb.');
            originalPublicKey = `uploads/news/original/${filename}`;
            thumbnailPublicKey = `uploads/news/thumb/${thumbnailName}`;
            originalKey = newsOriginalObjectKey(filename);
            thumbnailKey = newsThumbnailObjectKey(thumbnailName);
            await runtime.storage.put(originalKey, imageFile.body, {
                contentType: info.contentType,
                deferredPublication: true
            });
            const thumbnail = await runtime.images.thumbnailPng(imageFile.body, 300, 200);
            await runtime.storage.put(thumbnailKey, thumbnail, {
                contentType: 'image/png',
                deferredPublication: true
            });
        }

        const user = await backofficeAuthRepository(c).findUserById(c.get('backofficeUser')!.id);
        if (!user) {
            if (runtime.storage) {
                await Promise.all([originalKey, thumbnailKey].filter(Boolean).map((key) =>
                    deleteObjectWithCompensation(runtime, key)
                ));
            }
            return c.json({ success: false, msg: '用户信息获取失败' });
        }
        await newsRepository(c).insertNews({
            title: submission.title.trim(),
            image: originalPublicKey ? `/${originalPublicKey}` : '',
            thumbnail: thumbnailPublicKey ? `/${thumbnailPublicKey}` : '',
            content: url.href,
            date: new Date().toISOString(),
            author: user.producername || '未知P'
        });
        businessCommitted = true;
        if (runtime.storage?.publish) {
            try {
                await Promise.all([originalKey, thumbnailKey].filter(Boolean).map((key) =>
                    runtime.storage!.publish!(key)
                ));
            } catch (error) {
                console.error('Failed to publish committed news media; recovery will retry', error);
            }
        }
        await writeAudit(c, '发布新闻', submission.title);
        return c.json({ success: true });
    } catch (error) {
        if (runtime.storage && !businessCommitted) {
            await Promise.all([originalKey, thumbnailKey].filter(Boolean).map((key) =>
                deleteObjectWithCompensation(runtime, key).catch(() => undefined)
            ));
        }
        const status = statusFromError(error);
        if (status >= 500) {
            console.error('Failed to create news', error);
            return c.json({ success: false, msg: '服务器异常' }, status as 500);
        }
        return c.json({ success: false, msg: messageFromError(error) }, status as 400);
    }
}
