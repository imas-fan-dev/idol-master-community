import type {
    FudabaOwnerOfficeRecord,
    FudabaOfficeStatus
} from '@/ports/repositories';
import { parseFudabaRevision } from '@/domains/fudaba/owner-card';

const SERIES_CODE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_CHARACTER_PATTERN = /[^a-z0-9\u4e00-\u9fa5]+/g;

export interface FudabaOfficeFields {
    name: string;
    intro: string;
    city: string;
    address: string;
    latitude: number;
    longitude: number;
    accent: string;
    isOpen: boolean;
    seriesCodes: string[];
}

export interface FudabaOfficeUpdate extends FudabaOfficeFields {
    expectedRevision: number;
}

const OFFICE_FIELDS = [
    'name',
    'intro',
    'city',
    'address',
    'latitude',
    'longitude',
    'accent',
    'isOpen',
    'seriesCodes'
] as const;

function badRequest(message: string): Error {
    return Object.assign(new Error(message), { status: 400 });
}

function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw badRequest('请求体必须是对象');
    }
    return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
    const expected = new Set(allowed);
    if (
        Object.keys(value).length !== allowed.length ||
        Object.keys(value).some((key) => !expected.has(key))
    ) {
        throw badRequest('请求体字段无效');
    }
}

function text(value: unknown, name: string, maximum: number, required: boolean): string {
    if (typeof value !== 'string') throw badRequest(`${name} 必须是字符串`);
    const normalized = value.trim();
    if (
        (required && !normalized) || normalized.length > maximum ||
        /[\u0000-\u001f\u007f]/.test(normalized)
    ) {
        throw badRequest(`${name} 长度或内容无效`);
    }
    return normalized;
}

function coordinate(value: unknown, name: string, minimum: number, maximum: number): number {
    if (
        typeof value !== 'number' || !Number.isFinite(value) ||
        value < minimum || value > maximum
    ) {
        throw badRequest(`${name} 必须是有效坐标`);
    }
    return value;
}

function seriesCodes(value: unknown): string[] {
    if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
        throw badRequest('seriesCodes 必须包含 1 至 8 个系列');
    }
    const result = value.map((entry) =>
        text(entry, 'seriesCode', 40, true)
    );
    if (
        result.some((entry) => !SERIES_CODE_PATTERN.test(entry)) ||
        new Set(result).size !== result.length
    ) {
        throw badRequest('seriesCodes 包含无效或重复系列');
    }
    return result;
}

function officeFields(body: Record<string, unknown>): FudabaOfficeFields {
    const accent = text(body.accent, 'accent', 7, true).toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(accent)) throw badRequest('accent 无效');
    if (typeof body.isOpen !== 'boolean') throw badRequest('isOpen 必须是布尔值');
    return {
        name: text(body.name, 'name', 80, true),
        intro: text(body.intro, 'intro', 2000, false),
        city: text(body.city, 'city', 100, true),
        address: text(body.address, 'address', 240, true),
        latitude: coordinate(body.latitude, 'latitude', -90, 90),
        longitude: coordinate(body.longitude, 'longitude', -180, 180),
        accent,
        isOpen: body.isOpen,
        seriesCodes: seriesCodes(body.seriesCodes)
    };
}

export function parseFudabaOfficeCreate(value: unknown): FudabaOfficeFields {
    const body = object(value);
    exactKeys(body, OFFICE_FIELDS);
    return officeFields(body);
}

export function parseFudabaOfficeUpdate(value: unknown): FudabaOfficeUpdate {
    const body = object(value);
    exactKeys(body, [...OFFICE_FIELDS, 'expectedRevision']);
    return {
        ...officeFields(body),
        expectedRevision: parseFudabaRevision(body.expectedRevision)
    };
}

export function parseFudabaOfficeRevision(value: unknown): number {
    const body = object(value);
    exactKeys(body, ['expectedRevision']);
    return parseFudabaRevision(body.expectedRevision);
}

export function validFudabaOfficeId(value: string): boolean {
    return value.length >= 1 && value.length <= 128 &&
        !/[\u0000-\u001f\u007f/\\]/.test(value);
}

export function fudabaMutationIdempotencyKey(request: Request): string {
    if (!request.headers.has('Idempotency-Key')) {
        throw badRequest('Idempotency-Key 必填');
    }
    const key = request.headers.get('Idempotency-Key') ?? '';
    if (
        !key || key !== key.trim() || key.length > 200 ||
        /[\u0000-\u001f\u007f]/.test(key)
    ) {
        throw badRequest('Idempotency-Key 无效');
    }
    return key;
}

export function fudabaOfficeSlug(name: string, id: string): string {
    const base = name.normalize('NFKC').toLowerCase()
        .replace(SLUG_CHARACTER_PATTERN, '-')
        .replace(/^-+|-+$/g, '') || 'office';
    const suffix = id.replace(/-/g, '').slice(0, 12).toLowerCase();
    return `${base.slice(0, 120 - suffix.length - 1).replace(/-+$/g, '')}-${suffix}`;
}

export function fudabaOwnerOfficeView(
    office: FudabaOwnerOfficeRecord
): Record<string, unknown> {
    const base = `/api/community/exchange/me/offices/${encodeURIComponent(office.id)}`;
    return {
        id: office.id,
        slug: office.slug,
        name: office.name,
        intro: office.intro,
        city: office.city,
        address: office.address,
        location: {
            latitude: office.latitude,
            longitude: office.longitude,
            precision: 'exact'
        },
        accent: office.accent,
        coverUrl: office.cover_object_key
            ? `${base}/media/cover?v=${office.revision}`
            : null,
        pendingCoverUrl: office.pending_cover_object_key
            ? `${base}/media/pending-cover?v=${office.revision}`
            : null,
        pendingCoverSubmittedAt: office.pending_cover_submitted_at,
        isOpen: office.is_open,
        visitorCount: office.visitor_count,
        status: office.status,
        revision: office.revision,
        seriesCodes: office.series_codes,
        createdAt: office.created_at,
        updatedAt: office.updated_at,
        archivedAt: office.archived_at
    };
}

export function fudabaOfficeConflict(
    revision: number,
    officeStatus: FudabaOfficeStatus
): Record<string, unknown> {
    return {
        success: false,
        code: 'FUDABA_OFFICE_STATE_CONFLICT',
        revision,
        officeStatus
    };
}
