import type { MiddlewareHandler } from 'hono';
import type { AppEnvironment } from '@/app';
import { isDynamicBusinessRequest, validatedRequestPath } from '@/middleware/rate-limit';

export const JSON_BODY_MAX_BYTES = 100 * 1024;
export const INFORMATION_JSON_BODY_MAX_BYTES = 600 * 1024;

function isJsonContentType(value: string | undefined): boolean {
    if (!value) return false;
    const mediaType = value.split(';', 1)[0].trim().toLowerCase();
    if (mediaType === 'application/json') return true;
    return /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(mediaType);
}

function isMultipartContentType(value: string | undefined): boolean {
    if (!value) return false;
    return value.split(';', 1)[0].trim().toLowerCase() === 'multipart/form-data';
}

function routeParsesJson(method: string, pathname: string): boolean {
    const normalizedMethod = method.toUpperCase();
    if (normalizedMethod === 'POST') {
        return pathname === '/api/login' ||
            pathname === '/api/admin/login' ||
            pathname === '/api/admin/auth/login' ||
            pathname === '/api/platform/auth/login' ||
            pathname === '/api/platform/auth/register' ||
            pathname === '/api/platform/auth/register/verification-code' ||
            pathname === '/api/emojis' ||
            pathname === '/api/reactions' ||
            pathname === '/api/wiki/parse_bilibili';
    }
    return normalizedMethod === 'DELETE' &&
        (pathname === '/api/emojis' || pathname === '/api/reactions');
}

function shouldLimitBody(request: Request, pathname: string): boolean {
    const contentType = request.headers.get('content-type') || undefined;
    if (isJsonContentType(contentType) || routeParsesJson(request.method, pathname)) {
        return true;
    }
    return !isMultipartContentType(contentType) &&
        isDynamicBusinessRequest(request.method, pathname);
}

function tooLarge(maxBytes: number): Response {
    return Response.json(
        { error: `JSON body exceeds ${maxBytes} byte limit` },
        { status: 413 }
    );
}

function routeBodyMaxBytes(request: Request, pathname: string, fallback: number): number {
    if (
        ['POST', 'PUT'].includes(request.method.toUpperCase()) &&
        (pathname === '/api/admin/information' || pathname.startsWith('/api/admin/information/'))
    ) {
        return INFORMATION_JSON_BODY_MAX_BYTES;
    }
    return fallback;
}

function replayBody(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
        }
    });
}

export function jsonBodyLimit(
    maxBytes = JSON_BODY_MAX_BYTES
): MiddlewareHandler<AppEnvironment> {
    return async (c, next) => {
        if (!c.req.raw.body || !shouldLimitBody(c.req.raw, validatedRequestPath(c))) {
            return next();
        }

        const pathname = validatedRequestPath(c);
        const requestMaxBytes = routeBodyMaxBytes(c.req.raw, pathname, maxBytes);

        const hasTransferEncoding = c.req.raw.headers.has('transfer-encoding');
        const contentLength = c.req.header('content-length');
        if (!hasTransferEncoding && contentLength && /^\d+$/.test(contentLength.trim())) {
            if (Number(contentLength) > requestMaxBytes) {
                await c.req.raw.body.cancel('JSON body limit exceeded').catch(() => undefined);
                return tooLarge(requestMaxBytes);
            }
        }

        const reader = c.req.raw.body.getReader();
        const chunks: Uint8Array[] = [];
        let received = 0;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                received += value.byteLength;
                if (received > requestMaxBytes) {
                    await reader.cancel('JSON body limit exceeded').catch(() => undefined);
                    return tooLarge(requestMaxBytes);
                }
                chunks.push(value);
            }
        } finally {
            reader.releaseLock();
        }

        const requestInit: RequestInit & { duplex: 'half' } = {
            body: replayBody(chunks),
            duplex: 'half'
        };
        c.req.raw = new Request(c.req.raw, requestInit);
        return next();
    };
}
