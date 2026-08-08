import type { ObjectStorage } from '@/ports/object-storage';
import type {
    FudabaPublicCardRecord,
    FudabaPublicOfficeRecord,
    FudabaPublicPlacedCardRecord
} from '@/ports/repositories';
import { requirePublicObjectUrl } from '@/utils/storage/public-object-url';

const CURSOR_VERSION = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_CURSOR_LENGTH = 2048;
const SERIES_CODE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const OFFICE_SLUG_PATTERN = /^[a-z0-9\u4e00-\u9fa5]+(?:-[a-z0-9\u4e00-\u9fa5]+)*$/;

export interface FudabaOfficeFilters {
    city?: string;
    seriesCode?: string;
    isOpen?: boolean;
}

export interface FudabaCardFilters {
    seriesCode?: string;
    available?: boolean;
    officeSlug?: string;
}

export interface FudabaOfficeCursor {
    visitorCount: number;
    id: string;
}

export interface FudabaCardCursor {
    createdAt: string;
    id: string;
}

export interface FudabaOfficeQuery {
    filters: FudabaOfficeFilters;
    limit: number;
    after?: FudabaOfficeCursor;
}

export interface FudabaCardQuery {
    filters: FudabaCardFilters;
    limit: number;
    after?: FudabaCardCursor;
}

function badRequest(message: string): Error {
    return Object.assign(new Error(message), { status: 400 });
}

function printableId(value: unknown): value is string {
    return typeof value === 'string' && value.length >= 1 && value.length <= 128 &&
        !/[\u0000-\u001f\u007f]/.test(value);
}

function parseLimit(value: string | null): number {
    if (value === null) return DEFAULT_LIMIT;
    if (!/^[1-9]\d*$/.test(value)) {
        throw badRequest(`limit must be an integer between 1 and ${MAX_LIMIT}`);
    }
    const limit = Number(value);
    if (!Number.isSafeInteger(limit) || limit > MAX_LIMIT) {
        throw badRequest(`limit must be an integer between 1 and ${MAX_LIMIT}`);
    }
    return limit;
}

function optionalText(
    value: string | null,
    name: string,
    maxLength: number
): string | undefined {
    if (value === null) return undefined;
    const normalized = value.trim();
    if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
        throw badRequest(`${name} is invalid`);
    }
    return normalized;
}

function optionalBoolean(value: string | null, name: string): boolean | undefined {
    if (value === null) return undefined;
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw badRequest(`${name} must be true or false`);
}

function validateQueryKeys(parameters: URLSearchParams, allowed: ReadonlySet<string>): void {
    for (const key of parameters.keys()) {
        if (!allowed.has(key)) throw badRequest(`Unsupported query parameter: ${key}`);
        if (parameters.getAll(key).length !== 1) {
            throw badRequest(`Query parameter must appear once: ${key}`);
        }
    }
}

export function assertNoFudabaQuery(url: string): void {
    validateQueryKeys(new URL(url).searchParams, new Set());
}

function encodeCursor(value: object): string {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodedCursor(value: string): Record<string, unknown> | null {
    if (
        !value || value.length > MAX_CURSOR_LENGTH ||
        !/^[A-Za-z0-9_-]+$/.test(value)
    ) {
        return null;
    }
    try {
        const bytes = Buffer.from(value, 'base64url');
        if (bytes.toString('base64url') !== value) return null;
        const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null;
    } catch {
        return null;
    }
}

function sameFilters(actual: unknown, expected: object): boolean {
    return JSON.stringify(actual) === JSON.stringify(expected);
}

function parseSeriesCode(value: string | null): string | undefined {
    const seriesCode = optionalText(value, 'series', 40);
    if (seriesCode && !SERIES_CODE_PATTERN.test(seriesCode)) {
        throw badRequest('series is invalid');
    }
    return seriesCode;
}

export function encodeFudabaOfficeCursor(
    filters: FudabaOfficeFilters,
    after: FudabaOfficeCursor
): string {
    if (!Number.isSafeInteger(after.visitorCount) || after.visitorCount < 0 ||
        !printableId(after.id)) {
        throw new Error('Invalid Fudaba office cursor state');
    }
    return encodeCursor({
        version: CURSOR_VERSION,
        kind: 'offices',
        filters,
        after
    });
}

export function decodeFudabaOfficeCursor(
    value: string,
    filters: FudabaOfficeFilters
): FudabaOfficeCursor | null {
    const parsed = decodedCursor(value);
    const after = parsed?.after as Record<string, unknown> | undefined;
    if (
        parsed?.version !== CURSOR_VERSION || parsed.kind !== 'offices' ||
        !sameFilters(parsed.filters, filters) || !after ||
        !Number.isSafeInteger(after.visitorCount) || Number(after.visitorCount) < 0 ||
        !printableId(after.id)
    ) {
        return null;
    }
    return { visitorCount: Number(after.visitorCount), id: after.id };
}

export function encodeFudabaCardCursor(
    filters: FudabaCardFilters,
    after: FudabaCardCursor
): string {
    if (!printableId(after.id) || new Date(after.createdAt).toISOString() !== after.createdAt) {
        throw new Error('Invalid Fudaba card cursor state');
    }
    return encodeCursor({
        version: CURSOR_VERSION,
        kind: 'cards',
        filters,
        after
    });
}

export function decodeFudabaCardCursor(
    value: string,
    filters: FudabaCardFilters
): FudabaCardCursor | null {
    const parsed = decodedCursor(value);
    const after = parsed?.after as Record<string, unknown> | undefined;
    if (
        parsed?.version !== CURSOR_VERSION || parsed.kind !== 'cards' ||
        !sameFilters(parsed.filters, filters) || !after ||
        !printableId(after.id) || typeof after.createdAt !== 'string'
    ) {
        return null;
    }
    try {
        if (new Date(after.createdAt).toISOString() !== after.createdAt) return null;
    } catch {
        return null;
    }
    return { createdAt: after.createdAt, id: after.id };
}

export function parseFudabaOfficeQuery(url: string): FudabaOfficeQuery {
    const parameters = new URL(url).searchParams;
    validateQueryKeys(parameters, new Set(['city', 'series', 'open', 'limit', 'cursor']));
    const city = optionalText(parameters.get('city'), 'city', 100);
    const seriesCode = parseSeriesCode(parameters.get('series'));
    const isOpen = optionalBoolean(parameters.get('open'), 'open');
    const filters = {
        ...(city ? { city } : {}),
        ...(seriesCode ? { seriesCode } : {}),
        ...(isOpen === undefined ? {} : { isOpen })
    };
    const cursorValue = parameters.get('cursor');
    const after = cursorValue ? decodeFudabaOfficeCursor(cursorValue, filters) : undefined;
    if (cursorValue && !after) throw badRequest('Invalid Fudaba office cursor');
    return {
        filters,
        limit: parseLimit(parameters.get('limit')),
        ...(after ? { after } : {})
    };
}

export function parseFudabaCardQuery(url: string): FudabaCardQuery {
    const parameters = new URL(url).searchParams;
    validateQueryKeys(
        parameters,
        new Set(['series', 'available', 'office', 'limit', 'cursor'])
    );
    const seriesCode = parseSeriesCode(parameters.get('series'));
    const available = optionalBoolean(parameters.get('available'), 'available');
    const officeSlug = optionalText(parameters.get('office'), 'office', 120);
    if (officeSlug && !OFFICE_SLUG_PATTERN.test(officeSlug)) {
        throw badRequest('office is invalid');
    }
    const filters = {
        ...(seriesCode ? { seriesCode } : {}),
        ...(available === undefined ? {} : { available }),
        ...(officeSlug ? { officeSlug } : {})
    };
    const cursorValue = parameters.get('cursor');
    const after = cursorValue ? decodeFudabaCardCursor(cursorValue, filters) : undefined;
    if (cursorValue && !after) throw badRequest('Invalid Fudaba card cursor');
    return {
        filters,
        limit: parseLimit(parameters.get('limit')),
        ...(after ? { after } : {})
    };
}

export function validFudabaOfficeSlug(value: string): boolean {
    return value.length <= 120 && OFFICE_SLUG_PATTERN.test(value);
}

export async function fudabaPublicOfficeView(
    storage: ObjectStorage | undefined,
    office: FudabaPublicOfficeRecord
): Promise<Record<string, unknown>> {
    let coverUrl: string | null = null;
    if (office.cover_object_key) {
        if (!storage) {
            throw Object.assign(new Error('公开对象读取地址未配置'), { status: 503 });
        }
        coverUrl = await requirePublicObjectUrl(storage, office.cover_object_key);
    }
    return {
        id: office.id,
        slug: office.slug,
        name: office.name,
        intro: office.intro,
        city: office.city,
        accent: office.accent,
        coverUrl,
        isOpen: office.is_open,
        visitorCount: office.visitor_count,
        seriesCodes: office.series_codes
    };
}

export async function fudabaPublicCardView(
    storage: ObjectStorage | undefined,
    card: FudabaPublicCardRecord
): Promise<Record<string, unknown>> {
    if (!storage) {
        throw Object.assign(new Error('公开对象读取地址未配置'), { status: 503 });
    }
    const [frontImageUrl, backImageUrl] = await Promise.all([
        requirePublicObjectUrl(storage, card.front_object_key),
        requirePublicObjectUrl(storage, card.back_object_key)
    ]);
    return {
        id: card.id,
        producerName: card.producer_name,
        displayName: card.display_name,
        seriesCode: card.series_code,
        favoriteIdol: card.favorite_idol,
        frontImageUrl,
        backImageUrl,
        accent: card.accent,
        bio: card.bio,
        tradeNote: card.trade_note,
        available: card.available,
        source: card.source_url ? {
            url: card.source_url,
            label: card.source_label,
            credit: card.source_credit
        } : null,
        createdAt: card.created_at,
        interactions: {
            likes: card.like_count,
            favorites: card.favorite_count,
            viewerLiked: card.viewer_liked,
            viewerFavorited: card.viewer_favorited
        }
    };
}

export async function fudabaPublicPlacedCardView(
    storage: ObjectStorage | undefined,
    card: FudabaPublicPlacedCardRecord
): Promise<Record<string, unknown>> {
    return {
        ...await fudabaPublicCardView(storage, card),
        viewerOwned: card.viewer_owned,
        placement: {
            pinnedAt: card.pinned_at,
            x: card.position_x,
            y: card.position_y,
            rotation: card.rotation,
            zIndex: card.z_index,
            revision: card.revision,
            updatedAt: card.updated_at
        }
    };
}
