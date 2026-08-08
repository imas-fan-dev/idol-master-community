import type { Context, Env } from 'hono';
import { getCookie } from 'hono/cookie';
import type { ParsedUpload, UploadedFile } from '@/ports/http';
import type { RuntimeServices } from '@/ports/runtime-services';
import type { NewStoryLinkInput, StoryRepository } from '@/ports/repositories';
import {
    BACKOFFICE_ACCESS_TOKEN_COOKIE,
    LEGACY_BACKOFFICE_ACCESS_TOKEN_COOKIE,
    type BackofficeCookieSource
} from '@/domains/backoffice-auth/backoffice-auth-session';
import { DEFAULT_STORY_UPLOAD_MAX_BYTES, toWikiAgency, toWikiIdolFromRecord } from '@/domains/wiki/service';
import { deleteObjectWithCompensation } from '@/utils/storage/delete-object';

export type WikiServicesResolver<E extends Env> = (
    context: Context<E>
) => RuntimeServices | Promise<RuntimeServices>;

const jsonHeaders = { 'Content-Type': 'application/json; charset=UTF-8' };

export const wikiErrorBody = (msg: string) => ({ status: 'error', msg });

export function wikiJson(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

export function wikiPlain(body: string, status: number): Response {
    return new Response(body, {
        status,
        headers: { 'Content-Type': 'text/plain; charset=UTF-8' }
    });
}

export function wikiStatusOf(error: unknown, fallback = 500): number {
    const status = (error as { status?: unknown })?.status;
    return typeof status === 'number' && Number.isInteger(status) ? status : fallback;
}

export function wikiMessageOf(error: unknown, fallback: string): string {
    return error instanceof Error && error.message ? error.message : fallback;
}

function wikiBackofficeAccessToken<E extends Env>(
    context: Context<E>
): { source: BackofficeCookieSource; value: string } | undefined {
    const canonical = getCookie(context, BACKOFFICE_ACCESS_TOKEN_COOKIE);
    if (canonical) return { source: 'canonical', value: canonical };
    const legacy = getCookie(context, LEGACY_BACKOFFICE_ACCESS_TOKEN_COOKIE);
    return legacy ? { source: 'legacy', value: legacy } : undefined;
}

export async function authorizeWikiRead<E extends Env>(
    context: Context<E>,
    services: RuntimeServices
): Promise<Response | null> {
    if (!services.backofficeTokens) {
        throw new Error('Wiki backoffice token service is not configured');
    }
    const token = wikiBackofficeAccessToken(context);
    if (!token) return wikiJson(wikiErrorBody('未登录，请先登录'), 401);
    try {
        const claims = token.source === 'legacy'
            ? await (
                services.backofficeTokens.verifyLegacyCookie?.(token.value) ??
                services.backofficeTokens.verify(token.value)
            )
            : await services.backofficeTokens.verify(token.value);
        if (!['op', 'editor'].includes(claims.dept)) {
            return wikiJson(wikiErrorBody('无权限执行此操作'), 403);
        }
    } catch {
        return wikiJson(wikiErrorBody('未登录，请先登录'), 401);
    }
    return null;
}

function constantTimeEqual(left: string, right: string): boolean {
    const leftBytes = new TextEncoder().encode(left);
    const rightBytes = new TextEncoder().encode(right);
    let difference = leftBytes.length ^ rightBytes.length;
    const length = Math.max(leftBytes.length, rightBytes.length);
    for (let index = 0; index < length; index += 1) {
        difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
    }
    return difference === 0;
}

export async function authorizeWikiWrite<E extends Env>(
    context: Context<E>,
    services: RuntimeServices
): Promise<Response | null> {
    if (!services.backofficeTokens) {
        throw new Error('Wiki backoffice token service is not configured');
    }
    const token = wikiBackofficeAccessToken(context);
    if (!token) return wikiJson(wikiErrorBody('未登录，请先登录'), 401);
    let claims;
    try {
        claims = token.source === 'legacy'
            ? await (
                services.backofficeTokens.verifyLegacyCookie?.(token.value) ??
                services.backofficeTokens.verify(token.value)
            )
            : await services.backofficeTokens.verify(token.value);
    } catch {
        return wikiJson(wikiErrorBody('未登录，请先登录'), 401);
    }
    if (!['op', 'editor'].includes(claims.dept)) {
        return wikiJson(wikiErrorBody('无权限执行此操作'), 403);
    }
    const csrf = context.req.header('X-CSRFToken');
    if (
        !csrf || typeof claims.csrfSecret !== 'string' ||
        !constantTimeEqual(csrf, claims.csrfSecret)
    ) {
        return wikiJson(wikiErrorBody('CSRF token 无效，请刷新页面重试'), 403);
    }
    return null;
}

export function decodeWikiSegment(value: string): string {
    let decoded = value;
    for (let iteration = 0; iteration < 2; iteration += 1) {
        let next: string;
        try {
            next = decodeURIComponent(decoded);
        } catch {
            if (iteration === 0) throw new Error('Forbidden');
            break;
        }
        if (next === decoded) break;
        decoded = next;
        if (!decoded || decoded === '.' || decoded === '..' || /[\\/\0-\x1f\x7f]/.test(decoded)) {
            throw new Error('Forbidden');
        }
    }
    if (!decoded || decoded === '.' || decoded === '..' || /[\\/\0-\x1f\x7f]/.test(decoded)) {
        throw new Error('Forbidden');
    }
    return decoded;
}

export async function parseWikiUpload(
    request: Request,
    services: RuntimeServices
): Promise<ParsedUpload> {
    const maxBytes = services.config?.storyMaxUploadBytes ?? DEFAULT_STORY_UPLOAD_MAX_BYTES;
    const contentLength = Number(request.headers.get('content-length') || '0');
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        throw Object.assign(new Error('上传文件超过大小限制'), { status: 413 });
    }
    const contentType = request.headers.get('content-type')?.toLocaleLowerCase() ?? '';
    if (contentType.startsWith('application/x-www-form-urlencoded')) {
        const body = await request.text();
        if (new TextEncoder().encode(body).byteLength > maxBytes) {
            throw Object.assign(new Error('上传文件超过大小限制'), { status: 413 });
        }
        return { fields: Object.fromEntries(new URLSearchParams(body)), files: {} };
    }
    if (!services.uploads) throw new Error('Wiki upload parser is not configured');
    return services.uploads.parse(request, {
        maxBytes,
        fileFields: ['image'],
        maxFiles: 1,
        maxFields: 24,
        maxParts: 25
    });
}

export function singleWikiFile(
    upload: ParsedUpload,
    field: string
): UploadedFile | undefined {
    const value = upload.files[field];
    return Array.isArray(value) ? value[0] : value;
}

export function splitStoryUrl(raw: string): { url: string; subtitle: string } {
    const separator = raw.indexOf(' | ');
    return separator < 0
        ? { url: raw.trim(), subtitle: '' }
        : {
            url: raw.slice(0, separator).trim(),
            subtitle: raw.slice(separator + 3).trim()
        };
}

export interface WikiStorySourceDraft {
    upName: string;
    videoTitle: string;
    url: string;
    contentTypeId?: number;
    sourcePlatformId?: number;
}

export function optionalWikiCatalogId(value: unknown, label: string): number | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    const id = typeof value === 'number' ? value : Number(value);
    if (!Number.isSafeInteger(id) || id <= 0) {
        throw Object.assign(new Error(`${label} ID 无效`), { status: 400 });
    }
    return id;
}

export async function resolveWikiStorySources(
    repository: StoryRepository,
    drafts: WikiStorySourceDraft[]
): Promise<NewStoryLinkInput[]> {
    if (!drafts.length) return [];
    const [contentTypes, sourcePlatforms] = await Promise.all([
        repository.listStoryContentTypes(),
        repository.listStorySourcePlatforms()
    ]);
    const contentTypesById = new Map(contentTypes.map((option) => [option.id, option]));
    const sourcePlatformsById = new Map(
        sourcePlatforms.map((option) => [option.id, option])
    );
    const defaultContentType = contentTypes.find((option) =>
        option.is_active && option.name === '剧情'
    ) ?? contentTypes.find((option) => option.is_active);
    const defaultSourcePlatform = sourcePlatforms.find((option) =>
        option.is_active && option.name === '其他来源'
    ) ?? sourcePlatforms.find((option) => option.is_active);
    const bilibiliPlatform = sourcePlatforms.find((option) =>
        option.is_active && option.name.toLocaleLowerCase() === 'bilibili'
    );
    if (!defaultContentType || !defaultSourcePlatform) {
        throw Object.assign(new Error('请先在管理端启用内容类型和来源平台'), { status: 409 });
    }
    return drafts.map((draft, index) => {
        const contentType = draft.contentTypeId
            ? contentTypesById.get(draft.contentTypeId)
            : defaultContentType;
        const inferredPlatform = /(?:bilibili\.com|b23\.tv)\//i.test(draft.url)
            ? bilibiliPlatform
            : undefined;
        const sourcePlatform = draft.sourcePlatformId
            ? sourcePlatformsById.get(draft.sourcePlatformId)
            : inferredPlatform ?? defaultSourcePlatform;
        if (!contentType) {
            throw Object.assign(new Error(`第 ${index + 1} 个来源的内容类型不存在`), {
                status: 400
            });
        }
        if (!sourcePlatform) {
            throw Object.assign(new Error(`第 ${index + 1} 个来源的平台不存在`), {
                status: 400
            });
        }
        return {
            ...draft,
            contentTypeId: contentType.id,
            sourcePlatformId: sourcePlatform.id
        };
    });
}

export async function findWikiMutationTarget(
    services: RuntimeServices,
    agencyName: string,
    idolName: string,
    errorStatus = 200
) {
    const repository = services.story!;
    const agencyRecord = await repository.findAgencyByName(agencyName) ??
        await repository.findAgencyByCode(agencyName);
    const agency = agencyRecord ? toWikiAgency(agencyRecord) : null;
    if (!agency) {
        return { error: wikiJson(wikiErrorBody('企划不存在'), errorStatus) } as const;
    }
    const idolRecord = await repository.findIdolByAgencyAndName(agency.id, idolName);
    if (!idolRecord) {
        return { error: wikiJson(wikiErrorBody('找不到该内容页'), errorStatus) } as const;
    }
    return { agency, idol: toWikiIdolFromRecord(agency, idolRecord) } as const;
}

export async function findWikiAgencyTarget(
    services: RuntimeServices,
    agencyNameOrCode: string
) {
    const repository = services.story!;
    const agencyRecord = await repository.findAgencyByName(agencyNameOrCode) ??
        await repository.findAgencyByCode(agencyNameOrCode);
    const agency = agencyRecord ? toWikiAgency(agencyRecord) : null;
    if (!agency) {
        return { error: wikiJson(wikiErrorBody('企划不存在'), 404) } as const;
    }
    return { agency } as const;
}

export async function cleanupWikiObjects(
    services: RuntimeServices,
    keys: Iterable<string>
): Promise<void> {
    if (!services.storage) return;
    const uniqueKeys = [...new Set(keys)];
    const results = await Promise.allSettled(
        uniqueKeys.map((key) => deleteObjectWithCompensation(services, key))
    );
    for (const [index, result] of results.entries()) {
        if (result.status === 'rejected') {
            console.error(
                `Failed to clean committed Wiki object: ${uniqueKeys[index]}`,
                result.reason
            );
        }
    }
}

export async function cleanupWikiObjectPrefix(
    services: RuntimeServices,
    prefix: string,
    knownKeys: Iterable<string>
): Promise<void> {
    const keys = [...knownKeys];
    const directoryPrefix = `${prefix.replace(/\/+$/, '')}/`;
    try {
        keys.push(...(await services.storage!.list(directoryPrefix))
            .filter((object) => object.key.startsWith(directoryPrefix))
            .map((object) => object.key));
    } catch (error) {
        console.error(`Failed to enumerate committed Wiki prefix: ${directoryPrefix}`, error);
    }
    await cleanupWikiObjects(services, keys);
}
