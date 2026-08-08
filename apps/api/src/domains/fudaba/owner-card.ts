import type { FudabaCardRecord } from '@/ports/repositories';

export interface FudabaCardFields {
    accent: string;
    available: boolean;
    bio: string;
    displayName: string;
    favoriteIdol: string;
    producerName: string;
    seriesCode: string;
    tradeNote: string;
}

export interface FudabaCardUpdate extends FudabaCardFields {
    expectedRevision: number;
}

const CARD_FIELDS = [
    'producerName',
    'displayName',
    'seriesCode',
    'favoriteIdol',
    'accent',
    'bio',
    'tradeNote',
    'available'
] as const;

function badRequest(message: string): Error {
    return Object.assign(new Error(message), { status: 400 });
}

function text(
    value: unknown,
    name: string,
    maximum: number,
    required = false
): string {
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

function booleanValue(value: unknown): boolean {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    throw badRequest('available 必须是布尔值');
}

function cardFields(value: Record<string, unknown>): FudabaCardFields {
    const seriesCode = text(value.seriesCode, 'seriesCode', 64, true);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(seriesCode)) {
        throw badRequest('seriesCode 无效');
    }
    const accent = text(value.accent, 'accent', 7, true);
    if (!/^#[0-9a-fA-F]{6}$/.test(accent)) throw badRequest('accent 无效');
    return {
        producerName: text(value.producerName, 'producerName', 80, true),
        displayName: text(value.displayName, 'displayName', 120, true),
        seriesCode,
        favoriteIdol: text(value.favoriteIdol, 'favoriteIdol', 200),
        accent,
        bio: text(value.bio, 'bio', 2000),
        tradeNote: text(value.tradeNote, 'tradeNote', 1000),
        available: booleanValue(value.available)
    };
}

function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw badRequest('请求体必须是对象');
    }
    return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
    const expected = new Set(allowed);
    if (Object.keys(value).some((key) => !expected.has(key))) {
        throw badRequest('请求体包含未知字段');
    }
}

export function parseFudabaCardCreateFields(
    fields: Record<string, string>
): FudabaCardFields {
    exactKeys(fields, CARD_FIELDS);
    return cardFields(fields);
}

export function parseFudabaCardUpdate(value: unknown): FudabaCardUpdate {
    const body = object(value);
    exactKeys(body, [...CARD_FIELDS, 'expectedRevision']);
    return {
        ...cardFields(body),
        expectedRevision: parseFudabaRevision(body.expectedRevision)
    };
}

export function parseFudabaRevision(value: unknown): number {
    const revision = typeof value === 'string' && /^\d+$/.test(value)
        ? Number(value)
        : value;
    if (!Number.isSafeInteger(revision) || Number(revision) < 0) {
        throw badRequest('expectedRevision 必须是非负整数');
    }
    return Number(revision);
}

export function parseFudabaDelete(value: unknown): number {
    const body = object(value);
    exactKeys(body, ['expectedRevision']);
    return parseFudabaRevision(body.expectedRevision);
}

export function validFudabaCardId(value: string): boolean {
    return value.length >= 1 && value.length <= 128 &&
        !/[\u0000-\u001f\u007f/\\]/.test(value);
}

export function fudabaOwnerCardView(card: FudabaCardRecord): Record<string, unknown> {
    return {
        id: card.id,
        producerName: card.producer_name,
        displayName: card.display_name,
        seriesCode: card.series_code,
        favoriteIdol: card.favorite_idol,
        frontImageUrl: `/api/community/exchange/me/cards/${encodeURIComponent(card.id)}/media/front?v=${card.revision}`,
        backImageUrl: `/api/community/exchange/me/cards/${encodeURIComponent(card.id)}/media/back?v=${card.revision}`,
        accent: card.accent,
        bio: card.bio,
        tradeNote: card.trade_note,
        available: card.available,
        mediaRightsStatus: card.media_rights_status,
        publicationStatus: card.publication_status,
        revision: card.revision,
        createdAt: card.created_at,
        updatedAt: card.updated_at
    };
}
