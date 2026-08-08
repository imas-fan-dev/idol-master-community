import type { Context } from 'hono';
import type { AppEnvironment } from '@/app';
import {
    chroniclePrefix,
    safeChronicleSegment
} from '@/domains/chronicle/chronicle-records';
import { authenticateBackofficeRequest } from '@/middleware/hono-auth';
import { objectReadResponse } from '@/utils/http/object-read-response';
import { services } from '@/middleware/hono-context';

export async function handleServePendingChronicleMedia(
    c: Context<AppEnvironment>
): Promise<Response> {
    const authFailure = await authenticateBackofficeRequest(c);
    if (authFailure) return authFailure;
    if (c.get('backofficeUser')?.dept !== 'op') {
        return c.json({ message: '无权限（仅op可访问）' }, 403);
    }
    const activityId = safeChronicleSegment(c.req.param('activityId'), 'activityId');
    const filename = safeChronicleSegment(c.req.param('filename'), 'filename');
    const storage = services(c).storage;
    if (!storage) throw new Error('Object storage unavailable');
    const response = await objectReadResponse(
        c.req.raw,
        storage,
        chroniclePrefix('upload', activityId, filename),
        {
            'Cache-Control': 'private, no-store',
            'Vary': 'Cookie, Authorization'
        }
    );
    return response ?? c.text('Not Found', 404);
}
