import type { FudabaCardPlacementRecord } from '@/ports/repositories';

export interface FudabaCardPlacementSubmission {
    positionX: number;
    positionY: number;
    rotation: number;
    zIndex: number;
    expectedRevision: number | null;
}

const MAX_PLACEMENT_REVISION = 2_147_483_647;

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

function finiteNumber(
    value: unknown,
    name: string,
    minimum: number,
    maximum: number
): number {
    if (
        typeof value !== 'number' || !Number.isFinite(value) ||
        value < minimum || value > maximum
    ) {
        throw badRequest(`${name} 必须是 ${minimum} 到 ${maximum} 之间的数字`);
    }
    return value;
}

function zIndex(value: unknown): number {
    if (
        typeof value !== 'number' || !Number.isSafeInteger(value) ||
        value < 1 || value > 999
    ) {
        throw badRequest('zIndex 必须是 1 到 999 之间的整数');
    }
    return value;
}

function revision(value: unknown): number {
    if (
        typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 ||
        value > MAX_PLACEMENT_REVISION
    ) {
        throw badRequest(
            `expectedRevision 必须是 0 到 ${MAX_PLACEMENT_REVISION} 之间的整数`
        );
    }
    return value;
}

export function parseFudabaCardPlacement(
    value: unknown
): FudabaCardPlacementSubmission {
    const body = object(value);
    exactKeys(body, ['x', 'y', 'rotation', 'zIndex', 'expectedRevision']);
    return {
        positionX: finiteNumber(body.x, 'x', 0, 100),
        positionY: finiteNumber(body.y, 'y', 0, 100),
        rotation: finiteNumber(body.rotation, 'rotation', -12, 12),
        zIndex: zIndex(body.zIndex),
        expectedRevision: body.expectedRevision === null
            ? null
            : revision(body.expectedRevision)
    };
}

export function parseFudabaCardPlacementRemoval(value: unknown): number {
    const body = object(value);
    exactKeys(body, ['expectedRevision']);
    return revision(body.expectedRevision);
}

export function fudabaCardPlacementView(
    placement: FudabaCardPlacementRecord
): Record<string, unknown> {
    return {
        pinnedAt: placement.pinned_at,
        x: placement.position_x,
        y: placement.position_y,
        rotation: placement.rotation,
        zIndex: placement.z_index,
        revision: placement.revision,
        updatedAt: placement.updated_at
    };
}
