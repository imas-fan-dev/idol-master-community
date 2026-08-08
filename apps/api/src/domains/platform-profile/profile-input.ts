interface PlatformProfileSubmission {
    bio: string;
    displayName: string;
    expectedUpdatedAt: number;
    homeCity: string | null;
}

function badRequest(message: string): Error {
    return Object.assign(new Error(message), { status: 400 });
}

function text(value: unknown, field: string, maximum: number, required = false): string {
    if (typeof value !== 'string') throw badRequest(`${field} 必须是字符串`);
    const normalized = value.trim();
    if ((required && !normalized) || normalized.length > maximum) {
        throw badRequest(`${field} 长度无效`);
    }
    return normalized;
}

export function parsePlatformProfileSubmission(
    value: unknown
): PlatformProfileSubmission {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw badRequest('请求体必须是对象');
    }
    const body = value as Record<string, unknown>;
    const allowed = new Set(['displayName', 'homeCity', 'bio', 'expectedUpdatedAt']);
    if (Object.keys(body).some((key) => !allowed.has(key))) {
        throw badRequest('请求体包含未知字段');
    }
    if (!Number.isSafeInteger(body.expectedUpdatedAt) || Number(body.expectedUpdatedAt) < 0) {
        throw badRequest('expectedUpdatedAt 必须是非负整数');
    }
    const homeCity = body.homeCity === null
        ? null
        : text(body.homeCity, 'homeCity', 100) || null;
    return {
        displayName: text(body.displayName, 'displayName', 80, true),
        homeCity,
        bio: text(body.bio, 'bio', 2000),
        expectedUpdatedAt: Number(body.expectedUpdatedAt)
    };
}

export function parseExpectedProfileTimestamp(value: string | undefined): number {
    const expected = Number(value);
    if (!Number.isSafeInteger(expected) || expected < 0) {
        throw badRequest('expectedUpdatedAt 必须是非负整数');
    }
    return expected;
}
