import type {
    FudabaLocationReviewState,
    FudabaOfficeLocationReviewRecord,
    FudabaOfficePublicLocationRecord,
    FudabaPublicMapOfficeRecord,
    ListFudabaPublicMapOfficesInput
} from '@/ports/repositories';
import { parseFudabaRevision } from '@/domains/fudaba/owner-card';

const DEFAULT_MAP_LIMIT = 200;
const MAX_MAP_LIMIT = 500;
const DEFAULT_REVIEW_LIMIT = 50;
const MAX_REVIEW_LIMIT = 200;
const SERIES_CODE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

export const FUDABA_OWNER_LATITUDE_MIN = -60;
export const FUDABA_OWNER_LATITUDE_MAX = 60;

export interface FudabaOwnerLocationSubmission {
    latitudeE1: number;
    longitudeE1: number;
    expectedRevision: number | null;
}

export interface FudabaLocationReviewSubmission {
    decision: 'publish' | 'reject';
    expectedRevision: number;
    reviewNote: string;
}

function badRequest(message: string): Error {
    return Object.assign(new Error(message), { status: 400 });
}

function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw badRequest('请求体必须是对象');
    }
    return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
    const actual = Object.keys(value);
    const allowed = new Set(expected);
    if (
        actual.length !== expected.length ||
        actual.some((key) => !allowed.has(key))
    ) {
        throw badRequest('请求体字段无效');
    }
}

function validateQueryKeys(
    parameters: URLSearchParams,
    allowed: ReadonlySet<string>
): void {
    for (const key of parameters.keys()) {
        if (!allowed.has(key)) throw badRequest(`Unsupported query parameter: ${key}`);
        if (parameters.getAll(key).length !== 1) {
            throw badRequest(`Query parameter must appear once: ${key}`);
        }
    }
}

function optionalText(
    value: string | null,
    name: string,
    maxLength: number
): string | undefined {
    if (value === null) return undefined;
    const normalized = value.trim();
    if (
        !normalized || normalized.length > maxLength ||
        /[\u0000-\u001f\u007f]/.test(normalized)
    ) {
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

function positiveLimit(
    value: string | null,
    defaultValue: number,
    maximum: number
): number {
    if (value === null) return defaultValue;
    if (!/^[1-9]\d*$/.test(value)) {
        throw badRequest(`limit must be an integer between 1 and ${maximum}`);
    }
    const limit = Number(value);
    if (!Number.isSafeInteger(limit) || limit > maximum) {
        throw badRequest(`limit must be an integer between 1 and ${maximum}`);
    }
    return limit;
}

function decimal(value: string, name: string): number {
    if (!DECIMAL_PATTERN.test(value)) throw badRequest(`bbox ${name} is invalid`);
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw badRequest(`bbox ${name} is invalid`);
    return parsed;
}

function scaledBoundary(value: string, direction: 'lower' | 'upper'): number {
    const negative = value.startsWith('-');
    const unsigned = negative ? value.slice(1) : value;
    const [integerPart, fraction = ''] = unsigned.split('.');
    const tenths = BigInt(integerPart!) * 10n + BigInt(fraction[0] ?? '0');
    const hasRemainder = /[1-9]/.test(fraction.slice(1));
    if (!negative) {
        return Number(direction === 'lower' && hasRemainder ? tenths + 1n : tenths);
    }
    return Number(
        direction === 'upper' && hasRemainder
            ? -(tenths + 1n)
            : -tenths
    );
}

function bbox(value: string | null): ListFudabaPublicMapOfficesInput['bbox'] {
    if (value === null) throw badRequest('bbox is required');
    const parts = value.split(',');
    if (parts.length !== 4) {
        throw badRequest('bbox must contain west,south,east,north');
    }
    const [west, south, east, north] = [
        decimal(parts[0]!, 'west'),
        decimal(parts[1]!, 'south'),
        decimal(parts[2]!, 'east'),
        decimal(parts[3]!, 'north')
    ];
    if (
        west < -180 || west > 180 || east < -180 || east > 180 ||
        south < -90 || south > 90 || north < -90 || north > 90
    ) {
        throw badRequest('bbox is outside valid coordinate ranges');
    }
    if (west >= east) {
        throw badRequest('bbox must not cross the antimeridian in V1');
    }
    if (south >= north) throw badRequest('bbox south must be less than north');
    return {
        westE1: scaledBoundary(parts[0]!, 'lower'),
        southE1: scaledBoundary(parts[1]!, 'lower'),
        eastE1: scaledBoundary(parts[2]!, 'upper'),
        northE1: scaledBoundary(parts[3]!, 'upper')
    };
}

export function parseFudabaMapQuery(url: string): ListFudabaPublicMapOfficesInput {
    const parameters = new URL(url).searchParams;
    validateQueryKeys(
        parameters,
        new Set(['bbox', 'city', 'series', 'open', 'limit'])
    );
    const city = optionalText(parameters.get('city'), 'city', 100);
    const seriesCode = optionalText(parameters.get('series'), 'series', 40);
    if (seriesCode && !SERIES_CODE_PATTERN.test(seriesCode)) {
        throw badRequest('series is invalid');
    }
    const isOpen = optionalBoolean(parameters.get('open'), 'open');
    const bounds = bbox(parameters.get('bbox'));
    return {
        bbox: bounds,
        ...(city ? { city } : {}),
        ...(seriesCode ? { seriesCode } : {}),
        ...(isOpen === undefined ? {} : { isOpen }),
        limit: positiveLimit(parameters.get('limit'), DEFAULT_MAP_LIMIT, MAX_MAP_LIMIT)
    };
}

function coordinate(value: unknown, name: string, minimum: number, maximum: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
        throw badRequest(`${name} 必须是有效坐标`);
    }
    return Math.round(value * 10);
}

export function parseFudabaOwnerLocation(
    value: unknown
): FudabaOwnerLocationSubmission {
    const body = object(value);
    exactKeys(body, ['latitude', 'longitude', 'expectedRevision']);
    return {
        latitudeE1: coordinate(
            body.latitude,
            'latitude',
            FUDABA_OWNER_LATITUDE_MIN,
            FUDABA_OWNER_LATITUDE_MAX
        ),
        longitudeE1: coordinate(body.longitude, 'longitude', -180, 180),
        expectedRevision: body.expectedRevision === null
            ? null
            : parseFudabaRevision(body.expectedRevision)
    };
}

export function parseFudabaLocationWithdrawal(value: unknown): number {
    const body = object(value);
    exactKeys(body, ['expectedRevision']);
    return parseFudabaRevision(body.expectedRevision);
}

export function parseFudabaLocationReviewQuery(url: string): {
    reviewState: FudabaLocationReviewState;
    limit: number;
} {
    const parameters = new URL(url).searchParams;
    validateQueryKeys(parameters, new Set(['state', 'limit']));
    const state = parameters.get('state') ?? 'pending';
    if (!['pending', 'published', 'rejected'].includes(state)) {
        throw badRequest('state must be pending, published, or rejected');
    }
    return {
        reviewState: state as FudabaLocationReviewState,
        limit: positiveLimit(
            parameters.get('limit'),
            DEFAULT_REVIEW_LIMIT,
            MAX_REVIEW_LIMIT
        )
    };
}

export function parseFudabaLocationReview(
    value: unknown
): FudabaLocationReviewSubmission {
    const body = object(value);
    exactKeys(body, ['decision', 'expectedRevision', 'note']);
    if (body.decision !== 'publish' && body.decision !== 'reject') {
        throw badRequest('decision must be publish or reject');
    }
    if (typeof body.note !== 'string') throw badRequest('note 必须是字符串');
    const note = body.note.trim();
    if (note.length > 1000 || /[\u0000-\u001f\u007f]/.test(note)) {
        throw badRequest('note 长度或内容无效');
    }
    if (body.decision === 'reject' && !note) {
        throw badRequest('reject 必须填写 note');
    }
    return {
        decision: body.decision,
        expectedRevision: parseFudabaRevision(body.expectedRevision),
        reviewNote: note
    };
}

export function validFudabaOfficeId(value: string): boolean {
    return value.length >= 1 && value.length <= 128 &&
        !/[\u0000-\u001f\u007f/\\]/.test(value);
}

function regionalLocation(latitudeE1: number, longitudeE1: number) {
    return {
        latitude: latitudeE1 / 10,
        longitude: longitudeE1 / 10,
        precision: 'regional' as const
    };
}

export function fudabaPublicMapOfficeView(
    office: FudabaPublicMapOfficeRecord
): Record<string, unknown> {
    return {
        id: office.id,
        slug: office.slug,
        name: office.name,
        city: office.city,
        accent: office.accent,
        isOpen: office.is_open,
        seriesCodes: office.series_codes,
        location: regionalLocation(office.latitude_e1, office.longitude_e1)
    };
}

export function fudabaOwnerLocationView(
    location: FudabaOfficePublicLocationRecord
): Record<string, unknown> {
    return {
        officeId: location.office_id,
        location: regionalLocation(location.latitude_e1, location.longitude_e1),
        reviewState: location.review_state,
        revision: location.revision,
        submittedAt: location.submitted_at,
        reviewedAt: location.reviewed_at,
        reviewNote: location.review_note
    };
}

export function fudabaLocationReviewView(
    location: FudabaOfficeLocationReviewRecord
): Record<string, unknown> {
    return {
        officeId: location.office_id,
        officeName: location.office_name,
        city: location.office_city,
        ownerAccountId: location.owner_account_id,
        location: regionalLocation(location.latitude_e1, location.longitude_e1),
        reviewState: location.review_state,
        revision: location.revision,
        submittedAt: location.submitted_at,
        reviewedAt: location.reviewed_at,
        reviewedBy: location.reviewed_by,
        reviewNote: location.review_note
    };
}
