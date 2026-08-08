'use strict';

function fail(message) {
    throw new Error(message);
}

function equal(actual, expected, message) {
    if (!Object.is(actual, expected)) {
        fail(`${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
    }
}

function deepEqual(actual, expected, message) {
    const normalize = (value) => {
        if (Array.isArray(value)) return value.map(normalize);
        if (value && typeof value === 'object') {
            return Object.fromEntries(Object.entries(value).sort(([left], [right]) =>
                left.localeCompare(right)).map(([key, item]) => [key, normalize(item)]));
        }
        return value;
    };
    const actualJson = JSON.stringify(normalize(actual));
    const expectedJson = JSON.stringify(normalize(expected));
    if (actualJson !== expectedJson) {
        fail(`${message}: expected ${expectedJson}, received ${actualJson}`);
    }
}

function decodeJwtPart(token, index) {
    const part = token.split('.')[index];
    if (!part) fail(`JWT part ${index} is missing`);
    const normalized = part.replaceAll('-', '+').replaceAll('_', '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return JSON.parse(atob(padded));
}

async function json(response, message) {
    try {
        return await response.json();
    } catch (error) {
        fail(`${message}: response was not JSON (${error instanceof Error ? error.message : error})`);
    }
}

async function assertJsonResponse(response, status, body, message) {
    equal(response.status, status, `${message} status`);
    deepEqual(await json(response, message), body, `${message} body`);
}

function jsonReactionBody(byteLength, cardId) {
    const prefix = `{"id":${cardId},"emoji":"👍","padding":"`;
    const suffix = '"}';
    const fixedBytes = new TextEncoder().encode(prefix + suffix).byteLength;
    if (fixedBytes > byteLength) fail(`JSON fixture cannot fit in ${byteLength} bytes`);
    return prefix + 'a'.repeat(byteLength - fixedBytes) + suffix;
}

function unreadJsonBody() {
    let pulls = 0;
    const body = new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode('{'));
        },
        pull(controller) {
            pulls += 1;
            controller.enqueue(new TextEncoder().encode('{'));
            controller.close();
        }
    });
    return { body, pulls: () => pulls };
}

async function assertAbuseProtectionContract(fixture) {
    const maxBytes = 100 * 1024;
    equal(await fixture.rateLimitCount('global'), 0, `${fixture.runtime} global rate starts empty`);
    equal(fixture.compensationCount(), 0, `${fixture.runtime} compensation starts idle`);
    equal((await fixture.request('/assets/static-contract.js')).status, 404,
        `${fixture.runtime} static contract miss status`);
    equal((await fixture.request('/assets/static-contract.js', { method: 'HEAD' })).status, 404,
        `${fixture.runtime} static HEAD contract miss status`);
    await fixture.request('/api/reactions', { method: 'OPTIONS' });
    equal(await fixture.rateLimitCount('global'), 0,
        `${fixture.runtime} static and OPTIONS requests do not consume global quota`);
    equal(fixture.compensationCount(), 0,
        `${fixture.runtime} static and OPTIONS requests do not run compensation`);
    await assertJsonResponse(await fixture.request('/api/wiki/test'), 200, { status: 'ok' },
        `${fixture.runtime} compatibility probe`);
    equal(await fixture.rateLimitCount('global'), 0,
        `${fixture.runtime} compatibility probe does not consume global quota`);
    equal(fixture.compensationCount(), 0,
        `${fixture.runtime} compatibility probe does not run compensation`);

    const beforeEncodedDynamicGlobal = await fixture.rateLimitCount('global');
    const beforeEncodedDynamicCompensation = fixture.compensationCount();
    await assertJsonResponse(await fixture.request('/api/wiki/%74est'), 200, { status: 'ok' },
        `${fixture.runtime} percent-encoded compatibility probe`);
    equal(await fixture.rateLimitCount('global'), beforeEncodedDynamicGlobal,
        `${fixture.runtime} encoded compatibility probe does not consume global quota`);
    equal(fixture.compensationCount(), beforeEncodedDynamicCompensation,
        `${fixture.runtime} encoded compatibility probe does not run compensation`);

    await assertJsonResponse(await fixture.request(`/api/reactions?id=${fixture.cardId}`), 200, {},
        `${fixture.runtime} dynamic global rate probe`);
    equal(await fixture.rateLimitCount('global'), beforeEncodedDynamicGlobal + 1,
        `${fixture.runtime} dynamic API consumes global quota`);
    equal(fixture.compensationCount(), beforeEncodedDynamicCompensation + 1,
        `${fixture.runtime} accepted dynamic API runs compensation`);

    await assertJsonResponse(await fixture.request(`/api/%72eactions?id=${fixture.cardId}`), 200, {},
        `${fixture.runtime} percent-encoded dynamic route`);
    equal(await fixture.rateLimitCount('global'), beforeEncodedDynamicGlobal + 2,
        `${fixture.runtime} percent-encoded API consumes global quota`);
    equal(fixture.compensationCount(), beforeEncodedDynamicCompensation + 2,
        `${fixture.runtime} percent-encoded API runs compensation`);

    for (const malformedPath of ['/api/%', '/api/%E0%A4%A']) {
        const malformedBody = unreadJsonBody();
        const beforeMalformedGlobal = await fixture.rateLimitCount('global');
        const beforeMalformedCompensation = fixture.compensationCount();
        const beforeMalformedHandlers = fixture.handlerSnapshot();
        const malformed = await fixture.request(malformedPath, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: malformedBody.body,
            duplex: 'half'
        });
        equal(malformed.status, 403, `${fixture.runtime} malformed encoded path is rejected`);
        equal(malformedBody.pulls(), 0,
            `${fixture.runtime} malformed encoded path body remains unread`);
        equal(await fixture.rateLimitCount('global'), beforeMalformedGlobal,
            `${fixture.runtime} malformed encoded path bypasses rate storage`);
        equal(fixture.compensationCount(), beforeMalformedCompensation,
            `${fixture.runtime} malformed encoded path bypasses compensation`);
        deepEqual(fixture.handlerSnapshot(), beforeMalformedHandlers,
            `${fixture.runtime} malformed encoded path bypasses handlers`);
    }

    for (const encodedPath of ['/api/%2572eactions', '/api/%2Freactions']) {
        const beforeConfusedPathHandlers = fixture.handlerSnapshot();
        const confusedPath = await fixture.request(encodedPath);
        equal(confusedPath.status, 404,
            `${fixture.runtime} encoded path is not decoded twice`);
        deepEqual(fixture.handlerSnapshot(), beforeConfusedPathHandlers,
            `${fixture.runtime} non-canonical encoded path bypasses handlers`);
    }

    const globallyBlockedBody = unreadJsonBody();
    const beforeGlobalBlockedHandlers = fixture.handlerSnapshot();
    const beforeGlobalBlockedCompensation = fixture.compensationCount();
    fixture.blockNextGlobal();
    const globallyBlocked = await fixture.request('/api/reactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: globallyBlockedBody.body,
        duplex: 'half'
    });
    await assertJsonResponse(globallyBlocked, 429, { error: 'Too many requests' },
        `${fixture.runtime} global rate rejection`);
    equal(globallyBlockedBody.pulls(), 0,
        `${fixture.runtime} globally rejected body remains unread`);
    equal(fixture.compensationCount(), beforeGlobalBlockedCompensation,
        `${fixture.runtime} global rejection bypasses compensation`);
    deepEqual(fixture.handlerSnapshot(), beforeGlobalBlockedHandlers,
        `${fixture.runtime} global rejection bypasses handlers`);

    const sensitiveBody = unreadJsonBody();
    const beforeSensitiveGlobal = await fixture.rateLimitCount('global');
    const beforeSensitiveCompensation = fixture.compensationCount();
    const sensitive = await fixture.request('/api/.env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: sensitiveBody.body,
        duplex: 'half'
    });
    equal(sensitive.status, 403, `${fixture.runtime} sensitive path is rejected`);
    equal(sensitiveBody.pulls(), 0, `${fixture.runtime} sensitive path body remains unread`);
    equal(await fixture.rateLimitCount('global'), beforeSensitiveGlobal,
        `${fixture.runtime} sensitive path bypasses global rate storage`);
    equal(fixture.compensationCount(), beforeSensitiveCompensation,
        `${fixture.runtime} sensitive path bypasses compensation`);

    const exactBody = jsonReactionBody(maxBytes, fixture.cardId);
    const beforeExact = fixture.handlerSnapshot();
    await assertJsonResponse(await fixture.request('/api/reactions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': String(maxBytes)
        },
        body: exactBody
    }), 200, { ok: true }, `${fixture.runtime} exact JSON body limit`);
    const afterExact = fixture.handlerSnapshot();
    equal(afterExact.reactionLookups, beforeExact.reactionLookups + 1,
        `${fixture.runtime} exact JSON reaches reaction lookup`);
    equal(afterExact.reactionMutations, beforeExact.reactionMutations + 1,
        `${fixture.runtime} exact JSON reaches reaction mutation`);

    const textPlainExact = jsonReactionBody(maxBytes, fixture.cardId);
    const beforeTextPlainExact = fixture.handlerSnapshot();
    await assertJsonResponse(await fixture.request('/api/reactions', {
        method: 'POST',
        headers: {
            'Content-Type': 'text/plain',
            'Content-Length': String(maxBytes)
        },
        body: textPlainExact
    }), 200, { ok: true }, `${fixture.runtime} exact mislabeled JSON body limit`);
    const afterTextPlainExact = fixture.handlerSnapshot();
    equal(afterTextPlainExact.reactionLookups, beforeTextPlainExact.reactionLookups + 1,
        `${fixture.runtime} exact mislabeled JSON reaches reaction lookup`);
    equal(afterTextPlainExact.reactionMutations, beforeTextPlainExact.reactionMutations + 1,
        `${fixture.runtime} exact mislabeled JSON reaches reaction mutation`);

    const beforePlusOne = fixture.handlerSnapshot();
    const beforePlusOneCompensation = fixture.compensationCount();
    await assertJsonResponse(await fixture.request('/api/reactions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/problem+json',
            'Content-Length': String(maxBytes + 1)
        },
        body: jsonReactionBody(maxBytes + 1, fixture.cardId)
    }), 413, { error: `JSON body exceeds ${maxBytes} byte limit` },
    `${fixture.runtime} JSON body limit plus one`);
    deepEqual(fixture.handlerSnapshot(), beforePlusOne,
        `${fixture.runtime} content-length rejection bypasses handlers`);
    equal(fixture.compensationCount(), beforePlusOneCompensation,
        `${fixture.runtime} content-length rejection bypasses compensation`);

    const beforeUnderreported = fixture.handlerSnapshot();
    const beforeUnderreportedCompensation = fixture.compensationCount();
    await assertJsonResponse(await fixture.request('/api/reactions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': '1'
        },
        body: jsonReactionBody(maxBytes + 1, fixture.cardId)
    }), 413, { error: `JSON body exceeds ${maxBytes} byte limit` },
    `${fixture.runtime} underreported content-length plus one`);
    deepEqual(fixture.handlerSnapshot(), beforeUnderreported,
        `${fixture.runtime} underreported content-length rejection bypasses handlers`);
    equal(fixture.compensationCount(), beforeUnderreportedCompensation,
        `${fixture.runtime} underreported content-length rejection bypasses compensation`);

    const beforeMislabeled = fixture.handlerSnapshot();
    const beforeMislabeledCompensation = fixture.compensationCount();
    await assertJsonResponse(await fixture.request('/api/reactions', {
        method: 'POST',
        headers: {
            'Content-Type': 'text/plain',
            'Content-Length': '1'
        },
        body: jsonReactionBody(maxBytes + 1, fixture.cardId)
    }), 413, { error: `JSON body exceeds ${maxBytes} byte limit` },
    `${fixture.runtime} mislabeled underreported JSON body limit`);
    deepEqual(fixture.handlerSnapshot(), beforeMislabeled,
        `${fixture.runtime} mislabeled JSON rejection bypasses handlers`);
    equal(fixture.compensationCount(), beforeMislabeledCompensation,
        `${fixture.runtime} mislabeled JSON rejection bypasses compensation`);

    const beforeMultipartDisguise = fixture.handlerSnapshot();
    const beforeMultipartDisguiseCompensation = fixture.compensationCount();
    await assertJsonResponse(await fixture.request('/api/reactions', {
        method: 'POST',
        headers: {
            'Content-Type': 'multipart/form-data; boundary=disguise',
            'Content-Length': '1'
        },
        body: jsonReactionBody(maxBytes + 1, fixture.cardId)
    }), 413, { error: `JSON body exceeds ${maxBytes} byte limit` },
    `${fixture.runtime} multipart-disguised JSON body limit`);
    deepEqual(fixture.handlerSnapshot(), beforeMultipartDisguise,
        `${fixture.runtime} multipart-disguised JSON rejection bypasses handlers`);
    equal(fixture.compensationCount(), beforeMultipartDisguiseCompensation,
        `${fixture.runtime} multipart-disguised JSON rejection bypasses compensation`);

    for (const encodedPath of [
        '/api/%72eactions',
        '/api/%6Cogin',
        '/api/admin/auth/%6Cogin',
        '/api/admin/%6Eews',
        '/api/wiki/parse_%62ilibili'
    ]) {
        const beforeEncodedLimit = fixture.handlerSnapshot();
        const beforeEncodedLimitCompensation = fixture.compensationCount();
        await assertJsonResponse(await fixture.request(encodedPath, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/plain',
                'Content-Length': String(maxBytes + 1)
            },
            body: jsonReactionBody(maxBytes + 1, fixture.cardId)
        }), 413, { error: `JSON body exceeds ${maxBytes} byte limit` },
        `${fixture.runtime} percent-encoded JSON route body limit (${encodedPath})`);
        deepEqual(fixture.handlerSnapshot(), beforeEncodedLimit,
            `${fixture.runtime} percent-encoded JSON rejection bypasses handlers (${encodedPath})`);
        equal(fixture.compensationCount(), beforeEncodedLimitCompensation,
            `${fixture.runtime} percent-encoded JSON rejection bypasses compensation (${encodedPath})`);
    }

    let streamPulls = 0;
    let streamCancelled = false;
    const oversizedStream = new ReadableStream({
        pull(controller) {
            streamPulls += 1;
            if (streamPulls > 4) fail(`${fixture.runtime} JSON limit kept consuming oversized stream`);
            controller.enqueue(new Uint8Array(64 * 1024));
        },
        cancel() {
            streamCancelled = true;
        }
    });
    const beforeStream = fixture.handlerSnapshot();
    const beforeStreamCompensation = fixture.compensationCount();
    await assertJsonResponse(await fixture.request('/api/reactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: oversizedStream,
        duplex: 'half'
    }), 413, { error: `JSON body exceeds ${maxBytes} byte limit` },
    `${fixture.runtime} chunked JSON body limit`);
    equal(streamCancelled, true, `${fixture.runtime} oversized JSON stream is cancelled`);
    equal(streamPulls <= 3, true, `${fixture.runtime} oversized JSON stream stops promptly`);
    deepEqual(fixture.handlerSnapshot(), beforeStream,
        `${fixture.runtime} streamed rejection bypasses handlers`);
    equal(fixture.compensationCount(), beforeStreamCompensation,
        `${fixture.runtime} streamed rejection bypasses compensation`);

    const multipart = await fixture.request('/api/multipart-contract-miss', {
        method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data; boundary=contract' },
        body: 'x'.repeat(maxBytes + 1)
    });
    equal(multipart.status, 404, `${fixture.runtime} multipart bypasses JSON body limit`);

    const loginCount = await fixture.rateLimitCount('auth-login');
    equal(loginCount <= 18, true, `${fixture.runtime} login contract has available quota`);
    await fixture.primeRateLimit('auth-login', 18 - loginCount, 20, 15 * 60);
    const beforeLegacyLogin = fixture.handlerSnapshot();
    const legacyLogin = await fixture.request('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
    });
    await assertJsonResponse(legacyLogin, 400, {
        success: false,
        message: '用户名或密码格式错误'
    }, `${fixture.runtime} legacy login request 19 reaches handler`);
    equal((await fixture.rateLimitCount('auth-login')), 19,
        `${fixture.runtime} legacy login uses the shared auth bucket`);
    deepEqual(fixture.handlerSnapshot(), beforeLegacyLogin,
        `${fixture.runtime} malformed legacy login stops before user lookup`);
    const beforeCanonicalLogin = fixture.handlerSnapshot();
    const canonicalLogin = await fixture.request('/api/admin/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
    });
    await assertJsonResponse(canonicalLogin, 400, {
        success: false,
        message: '用户名或密码格式错误'
    }, `${fixture.runtime} canonical Backoffice login request 20 reaches handler`);
    equal((await fixture.rateLimitCount('auth-login')), 20,
        `${fixture.runtime} canonical and legacy login share the auth bucket`);
    deepEqual(fixture.handlerSnapshot(), beforeCanonicalLogin,
        `${fixture.runtime} malformed canonical login stops before user lookup`);
    const beforeLoginBlocked = fixture.handlerSnapshot();
    const beforeLoginCompensation = fixture.compensationCount();
    const blockedLoginBody = unreadJsonBody();
    const loginBlocked = await fixture.request('/api/admin/auth/%6Cogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: blockedLoginBody.body,
        duplex: 'half'
    });
    await assertJsonResponse(loginBlocked, 429, { error: 'Too many requests' },
        `${fixture.runtime} percent-encoded canonical login request 21 shares auth bucket`);
    equal(typeof loginBlocked.headers.get('retry-after'), 'string',
        `${fixture.runtime} login limit exposes retry-after`);
    deepEqual(fixture.handlerSnapshot(), beforeLoginBlocked,
        `${fixture.runtime} blocked login bypasses JSON parsing and user lookup`);
    equal(blockedLoginBody.pulls(), 0, `${fixture.runtime} blocked login body remains unread`);
    equal(fixture.compensationCount(), beforeLoginCompensation,
        `${fixture.runtime} blocked login bypasses compensation`);

    const reactionCount = await fixture.rateLimitCount('reactions');
    await fixture.primeRateLimit('reactions', 300 - reactionCount, 300, 60 * 60);
    const beforeReactionBlocked = fixture.handlerSnapshot();
    const beforeReactionCompensation = fixture.compensationCount();
    const blockedReactionBody = unreadJsonBody();
    const reactionBlocked = await fixture.request('/api/reactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: blockedReactionBody.body,
        duplex: 'half'
    });
    await assertJsonResponse(reactionBlocked, 429, { error: 'Too many requests' },
        `${fixture.runtime} reaction request 301`);
    deepEqual(fixture.handlerSnapshot(), beforeReactionBlocked,
        `${fixture.runtime} blocked reaction bypasses lookup and mutation`);
    equal(blockedReactionBody.pulls(), 0, `${fixture.runtime} blocked reaction body remains unread`);
    equal(fixture.compensationCount(), beforeReactionCompensation,
        `${fixture.runtime} blocked reaction bypasses compensation`);
}

async function assertCoreAuthContract(fixture) {
    const login = await fixture.login();
    equal(login.response.status, 200, `${fixture.runtime} login status`);
    equal(decodeJwtPart(login.token, 0).alg, 'HS256', `${fixture.runtime} JWT algorithm`);
    const claims = decodeJwtPart(login.token, 1);
    equal(claims.id, fixture.expectedUser.id, `${fixture.runtime} JWT user id`);
    equal(claims.username, fixture.expectedUser.username, `${fixture.runtime} JWT username`);
    equal(claims.dept, fixture.expectedUser.dept, `${fixture.runtime} JWT role`);
    equal(typeof claims.iss, 'string', `${fixture.runtime} JWT issuer`);
    equal(claims.aud, 'ims-backoffice', `${fixture.runtime} JWT audience`);
    equal(claims.kind, 'backoffice', `${fixture.runtime} JWT realm kind`);
    equal(typeof claims.csrfSecret, 'string', `${fixture.runtime} JWT CSRF claim`);
    equal(claims.exp - claims.iat, 15 * 60, `${fixture.runtime} access JWT lifetime`);
    const loginCookies = fixture.setCookies(login.response);
    const loginTokenCookie = loginCookies.find((value) => value.startsWith('token='));
    const loginRefreshCookie = loginCookies.find((value) => value.startsWith('refresh_token='));
    const loginCsrfCookie = loginCookies.find((value) => value.startsWith('csrf_token='));
    if (!loginTokenCookie || !loginRefreshCookie || !loginCsrfCookie) {
        fail(`${fixture.runtime} login must set access, refresh, and CSRF cookies`);
    }
    for (const cookie of [loginTokenCookie, loginRefreshCookie, loginCsrfCookie]) {
        if (!/SameSite=Lax/i.test(cookie)) fail(`${fixture.runtime} login cookie must set SameSite=Lax: ${cookie}`);
        if (fixture.secureCookies && !/; Secure/i.test(cookie)) {
            fail(`${fixture.runtime} login cookie must set Secure: ${cookie}`);
        }
    }
    if (!/Path=\//i.test(loginTokenCookie) || !/Path=\//i.test(loginCsrfCookie)) {
        fail(`${fixture.runtime} access and CSRF cookies must set Path=/`);
    }
    if (!/Path=\/api/i.test(loginRefreshCookie)) {
        fail(`${fixture.runtime} refresh cookie must set Path=/api`);
    }
    if (!/; HttpOnly/i.test(loginTokenCookie)) fail(`${fixture.runtime} token cookie must be HttpOnly`);
    if (!/; HttpOnly/i.test(loginRefreshCookie)) fail(`${fixture.runtime} refresh cookie must be HttpOnly`);
    if (/; HttpOnly/i.test(loginCsrfCookie)) fail(`${fixture.runtime} CSRF cookie must remain script-readable`);

    const refresh = await fixture.request('/api/refresh', {
        method: 'POST',
        headers: {
            Cookie: login.cookie,
            'X-CSRFToken': login.csrf
        }
    });
    equal(refresh.status, 200, `${fixture.runtime} refresh status`);
    const refreshCookies = fixture.setCookies(refresh);
    const refreshedTokenCookie = refreshCookies.find((value) => value.startsWith('token='));
    const refreshedRefreshCookie = refreshCookies.find(
        (value) => value.startsWith('refresh_token=')
    );
    const refreshedCsrfCookie = refreshCookies.find((value) => value.startsWith('csrf_token='));
    if (!refreshedTokenCookie || !refreshedRefreshCookie || !refreshedCsrfCookie) {
        fail(`${fixture.runtime} refresh must rotate access and refresh cookies`);
    }
    if (refreshedRefreshCookie.split(';', 1)[0] === loginRefreshCookie.split(';', 1)[0]) {
        fail(`${fixture.runtime} refresh token must rotate`);
    }
    const refreshedCookieHeader = refreshCookies
        .map((value) => value.split(';', 1)[0])
        .join('; ');

    for (const authorization of [login.token, `Bearer ${login.token}`]) {
        const response = await fixture.request('/api/check', {
            headers: { Authorization: authorization }
        });
        equal(response.status, 200, `${fixture.runtime} ${authorization.startsWith('Bearer') ? 'Bearer' : 'naked'} auth`);
        const body = await json(response, `${fixture.runtime} check`);
        equal(body.success, true, `${fixture.runtime} check success`);
        equal(body.user.id, fixture.expectedUser.id, `${fixture.runtime} check user id`);
        equal(body.user.username, fixture.expectedUser.username, `${fixture.runtime} check username`);
        equal(body.user.dept, fixture.expectedUser.dept, `${fixture.runtime} check role`);
    }

    const wrongCsrf = await fixture.request(fixture.cookieMutationPath, {
        method: fixture.cookieMutationMethod || 'POST',
        headers: {
            Cookie: refreshedCookieHeader,
            'X-CSRFToken': 'wrong-contract-token'
        }
    });
    await assertJsonResponse(
        wrongCsrf,
        403,
        { success: false, message: 'CSRF token invalid' },
        `${fixture.runtime} Cookie CSRF mismatch`
    );
    await fixture.assertMutationState('before');

    const cookieWrite = await fixture.request(fixture.cookieMutationPath, {
        method: fixture.cookieMutationMethod || 'POST',
        headers: {
            Cookie: refreshedCookieHeader,
            'X-CSRFToken': login.csrf
        }
    });
    equal(cookieWrite.status, fixture.mutationSuccessStatus || 200, `${fixture.runtime} Cookie write`);
    await fixture.assertMutationState('after-cookie');

    await fixture.resetMutation();
    const authorizationWrite = await fixture.request(fixture.cookieMutationPath, {
        method: fixture.cookieMutationMethod || 'POST',
        headers: {
            Authorization: login.token,
            Cookie: 'unrelated=value'
        }
    });
    equal(
        authorizationWrite.status,
        fixture.mutationSuccessStatus || 200,
        `${fixture.runtime} Authorization write with unrelated Cookie`
    );
    await fixture.assertMutationState('after-authorization');

    const logout = await fixture.request('/api/logout', {
        method: 'POST',
        headers: {
            Cookie: refreshedCookieHeader,
            'X-CSRFToken': login.csrf
        }
    });
    await assertJsonResponse(logout, 200, { success: true }, `${fixture.runtime} logout`);
    const setCookie = fixture.setCookies(logout);
    const tokenCookie = setCookie.find((value) => value.startsWith('token='));
    const refreshCookie = setCookie.find((value) => value.startsWith('refresh_token='));
    const csrfCookie = setCookie.find((value) => value.startsWith('csrf_token='));
    if (!tokenCookie || !refreshCookie || !csrfCookie) {
        fail(`${fixture.runtime} logout must clear all authentication cookies`);
    }
    for (const cookie of [tokenCookie, refreshCookie, csrfCookie]) {
        if (!/Max-Age=0/i.test(cookie)) fail(`${fixture.runtime} logout cookie must set Max-Age=0: ${cookie}`);
        if (!/SameSite=Lax/i.test(cookie)) fail(`${fixture.runtime} logout cookie must preserve SameSite=Lax: ${cookie}`);
        if (fixture.secureCookies && !/; Secure/i.test(cookie)) {
            fail(`${fixture.runtime} logout cookie must preserve Secure: ${cookie}`);
        }
    }
    if (!/Path=\//i.test(tokenCookie) || !/Path=\//i.test(csrfCookie)) {
        fail(`${fixture.runtime} logout must preserve access and CSRF Path=/`);
    }
    if (!/Path=\/api/i.test(refreshCookie)) {
        fail(`${fixture.runtime} logout must preserve refresh Path=/api`);
    }
    if (!/; HttpOnly/i.test(tokenCookie)) fail(`${fixture.runtime} token logout cookie must remain HttpOnly`);
    if (!/; HttpOnly/i.test(refreshCookie)) fail(`${fixture.runtime} refresh logout cookie must remain HttpOnly`);
    if (/; HttpOnly/i.test(csrfCookie)) fail(`${fixture.runtime} CSRF logout cookie must remain script-readable`);

    return login;
}

async function assertReactionContract(fixture) {
    const payload = JSON.stringify({ id: fixture.cardId, emoji: fixture.emoji || '👍' });
    const headers = { 'Content-Type': 'application/json', ...(fixture.headers || {}) };
    await assertJsonResponse(
        await fixture.request('/api/emojis', { method: 'POST', headers, body: payload }),
        200,
        { success: true },
        `${fixture.runtime} /api/emojis mutation`
    );
    await assertJsonResponse(
        await fixture.request('/api/reactions', { method: 'POST', headers, body: payload }),
        200,
        { ok: true },
        `${fixture.runtime} /api/reactions mutation`
    );
    await assertJsonResponse(
        await fixture.request(`/api/reactions?id=${fixture.cardId}`),
        200,
        { [fixture.emoji || '👍']: 2 },
        `${fixture.runtime} reaction read`
    );
}

async function assertRejectedJwtContract(fixture) {
    for (const [label, token] of Object.entries(fixture.tokens)) {
        await assertJsonResponse(
            await fixture.request('/api/admin/auth/session', {
                headers: { Authorization: token }
            }),
            401,
            { success: false, message: 'token无效' },
            `${fixture.runtime} rejects ${label} JWT`
        );
    }
}

async function assertMediaRangeContract(fixture) {
    const cases = [
        { label: 'full GET', method: 'GET', status: 200, length: fixture.body.byteLength, body: fixture.body },
        { label: 'full HEAD', method: 'HEAD', status: 200, length: fixture.body.byteLength, body: new Uint8Array() },
        {
            label: 'closed range GET', method: 'GET', range: 'bytes=2-5', status: 206,
            length: 4, contentRange: `bytes 2-5/${fixture.body.byteLength}`,
            body: fixture.body.slice(2, 6)
        },
        {
            label: 'closed range HEAD', method: 'HEAD', range: 'bytes=2-5', status: 206,
            length: 4, contentRange: `bytes 2-5/${fixture.body.byteLength}`,
            body: new Uint8Array()
        },
        {
            label: 'open range', method: 'GET', range: 'bytes=3-', status: 206,
            length: fixture.body.byteLength - 3,
            contentRange: `bytes 3-${fixture.body.byteLength - 1}/${fixture.body.byteLength}`,
            body: fixture.body.slice(3)
        },
        {
            label: 'suffix range', method: 'GET', range: 'bytes=-4', status: 206,
            length: Math.min(4, fixture.body.byteLength),
            contentRange: `bytes ${Math.max(0, fixture.body.byteLength - 4)}-${fixture.body.byteLength - 1}/${fixture.body.byteLength}`,
            body: fixture.body.slice(-4)
        },
        {
            label: 'unsatisfied range', method: 'GET', range: `bytes=${fixture.body.byteLength}-`,
            status: 416, contentRange: `bytes */${fixture.body.byteLength}`, body: new Uint8Array()
        },
        {
            label: 'multiple range', method: 'GET', range: 'bytes=0-1,3-4',
            status: 416, contentRange: `bytes */${fixture.body.byteLength}`, body: new Uint8Array()
        }
    ];

    for (const item of cases) {
        const headers = item.range ? { Range: item.range, ...(fixture.headers || {}) } : fixture.headers;
        const response = await fixture.request(fixture.path, { method: item.method, headers });
        equal(response.status, item.status, `${fixture.runtime} ${item.label} status`);
        equal(response.headers.get('accept-ranges'), 'bytes', `${fixture.runtime} ${item.label} Accept-Ranges`);
        equal(response.headers.get('content-type'), fixture.contentType, `${fixture.runtime} ${item.label} MIME`);
        if (fixture.etag) equal(response.headers.get('etag'), fixture.etag, `${fixture.runtime} ${item.label} ETag`);
        if (item.length !== undefined) {
            equal(response.headers.get('content-length'), String(item.length), `${fixture.runtime} ${item.label} length`);
        }
        if (item.contentRange) {
            equal(response.headers.get('content-range'), item.contentRange, `${fixture.runtime} ${item.label} Content-Range`);
        }
        const actualBody = new Uint8Array(await response.arrayBuffer());
        deepEqual([...actualBody], [...item.body], `${fixture.runtime} ${item.label} body`);
    }
}

function multipartBytes(boundary, parts, includeClosingBoundary = true) {
    const chunks = [];
    for (const part of parts) {
        chunks.push(`--${boundary}\r\n`);
        if (part.filename !== undefined) {
            chunks.push(`Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`);
            chunks.push(`Content-Type: ${part.contentType || 'application/octet-stream'}\r\n\r\n`);
        } else {
            chunks.push(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n`);
        }
        chunks.push(part.body);
        chunks.push('\r\n');
    }
    if (includeClosingBoundary) chunks.push(`--${boundary}--\r\n`);
    const encoder = new TextEncoder();
    const encoded = chunks.map((chunk) => typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
    const size = encoded.reduce((total, chunk) => total + chunk.byteLength, 0);
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of encoded) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return body;
}

async function expectUploadFailure(operation, status, message) {
    try {
        await operation();
    } catch (error) {
        if (status !== undefined) equal(error?.status, status, `${message} error status`);
        return;
    }
    fail(`${message}: expected upload parser rejection`);
}

async function assertMultipartParserContract(fixture) {
    const boundary = 'ims-contract-boundary';
    const contentType = `multipart/form-data; boundary=${boundary}`;
    const exactBody = multipartBytes(boundary, [
        { name: 'title', body: 'contract' },
        {
            name: 'image', filename: 'fixture.png', contentType: 'image/png',
            body: new TextEncoder().encode('accepted-file')
        }
    ]);
    const accepted = await fixture.parse(
        fixture.request(exactBody, contentType),
        { maxBytes: exactBody.byteLength, fileFields: ['image'] }
    );
    equal(accepted.fields.title, 'contract', `${fixture.runtime} multipart field`);
    const acceptedFile = Array.isArray(accepted.files.image)
        ? accepted.files.image[0]
        : accepted.files.image;
    equal(acceptedFile?.filename, 'fixture.png', `${fixture.runtime} multipart filename`);

    await expectUploadFailure(
        () => fixture.parse(
            fixture.request(exactBody, contentType),
            { maxBytes: exactBody.byteLength - 1, fileFields: ['image'] }
        ),
        413,
        `${fixture.runtime} raw multipart boundary plus one`
    );

    const unknownBody = multipartBytes(boundary, [
        {
            name: 'ignored', filename: 'oversized.bin', contentType: 'application/octet-stream',
            body: new Uint8Array(1024).fill(65)
        },
        {
            name: 'image', filename: 'small.png', contentType: 'image/png',
            body: new Uint8Array([1])
        }
    ]);
    await expectUploadFailure(
        () => fixture.parse(
            fixture.request(unknownBody, contentType),
            { maxBytes: 512, fileFields: ['image'] }
        ),
        413,
        `${fixture.runtime} unknown file still counts toward request limit`
    );

    const interrupted = multipartBytes(boundary, [
        {
            name: 'image', filename: 'broken.png', contentType: 'image/png',
            body: new TextEncoder().encode('incomplete')
        }
    ], false);
    await expectUploadFailure(
        () => fixture.parse(
            fixture.request(interrupted, contentType),
            { maxBytes: interrupted.byteLength + 32, fileFields: ['image'] }
        ),
        undefined,
        `${fixture.runtime} interrupted multipart`
    );
}

async function assertIdempotentReplayContract(fixture) {
    const first = await fixture.invoke();
    equal(first.status, fixture.status || 200, `${fixture.runtime} ${fixture.operation} first status`);
    const firstBody = await json(first, `${fixture.runtime} ${fixture.operation} first response`);
    if (fixture.body !== undefined) {
        deepEqual(firstBody, fixture.body, `${fixture.runtime} ${fixture.operation} first body`);
    }
    const firstState = await fixture.snapshot();

    const replay = await fixture.invoke();
    equal(replay.status, first.status, `${fixture.runtime} ${fixture.operation} replay status`);
    deepEqual(
        await json(replay, `${fixture.runtime} ${fixture.operation} replay response`),
        firstBody,
        `${fixture.runtime} ${fixture.operation} replay body`
    );
    deepEqual(
        await fixture.snapshot(),
        firstState,
        `${fixture.runtime} ${fixture.operation} replay state`
    );
    return { body: firstBody, state: firstState };
}

function assertJsonContentType(response, message) {
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.toLowerCase().startsWith('application/json')) {
        fail(`${message}: expected JSON Content-Type, received ${JSON.stringify(contentType)}`);
    }
}

function uploadedFile(filename, size, fill = 1) {
    const body = new Uint8Array(size);
    body.fill(fill);
    return { filename, contentType: 'image/png', body };
}

async function assertCoreMutationContract(fixture) {
    const badLogin = await fixture.request('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: fixture.username, password: 'wrong-password' })
    });
    assertJsonContentType(badLogin, `${fixture.runtime} bad login`);
    await assertJsonResponse(
        badLogin, 401,
        { success: false, message: '用户名或密码错误' },
        `${fixture.runtime} bad login`
    );

    const login = await fixture.request('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: fixture.username, password: fixture.password })
    });
    equal(login.status, 200, `${fixture.runtime} login status`);
    assertJsonContentType(login, `${fixture.runtime} login`);
    const loginBody = await json(login, `${fixture.runtime} login`);
    deepEqual(
        Object.keys(loginBody).sort(),
        ['adminRole', 'dept', 'producername', 'success', 'token', 'username'],
        `${fixture.runtime} login response fields`
    );
    equal(loginBody.success, true, `${fixture.runtime} login success`);
    equal(loginBody.username, fixture.username, `${fixture.runtime} login username`);
    equal(loginBody.producername, fixture.producername, `${fixture.runtime} login producername`);
    equal(loginBody.dept, 'op', `${fixture.runtime} login role`);
    equal(loginBody.adminRole, 'admin', `${fixture.runtime} admin role`);
    equal(typeof loginBody.token, 'string', `${fixture.runtime} login token`);
    const auth = { Authorization: loginBody.token };

    const afterLogin = await fixture.snapshot();
    deepEqual(afterLogin.auditActions, ['登录'], `${fixture.runtime} login audit`);

    const invalidNews = await fixture.request('/api/admin/news', {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'bad', content: 'javascript:alert(1)' })
    });
    assertJsonContentType(invalidNews, `${fixture.runtime} invalid news`);
    await assertJsonResponse(
        invalidNews, 400,
        { success: false, msg: '资讯标题或链接无效' },
        `${fixture.runtime} invalid news`
    );
    deepEqual(await fixture.snapshot(), afterLogin, `${fixture.runtime} invalid news has no side effects`);

    const news = await fixture.request('/api/admin/news', {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Contract news', content: 'https://example.test/news' })
    });
    assertJsonContentType(news, `${fixture.runtime} news mutation`);
    await assertJsonResponse(news, 200, { success: true }, `${fixture.runtime} news mutation`);
    const afterNews = await fixture.snapshot();
    equal(afterNews.news, afterLogin.news + 1, `${fixture.runtime} news row committed`);
    deepEqual(afterNews.auditActions, ['登录', '发布新闻'], `${fixture.runtime} news audit after commit`);

    fixture.setUpload({
        fields: { title: 'Contract event', name: 'Producer', contact: 'contact@example.test' },
        files: { image: uploadedFile('event.png', 32, 2) }
    });
    const event = await fixture.request('/api/events', {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'multipart/form-data; boundary=contract' },
        body: '--contract--'
    });
    equal(event.status, 200, `${fixture.runtime} event mutation status`);
    assertJsonContentType(event, `${fixture.runtime} event mutation`);
    const eventBody = await json(event, `${fixture.runtime} event mutation`);
    equal(eventBody.success, true, `${fixture.runtime} event mutation success`);
    equal(Number.isSafeInteger(eventBody.id) && eventBody.id > 0, true, `${fixture.runtime} event id`);

    fixture.setUpload({
        fields: {},
        files: { images: [uploadedFile('front.png', 24, 3), uploadedFile('back.png', 24, 4)] }
    });
    const namecard = await fixture.request('/api/uploadNameCard', {
        method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data; boundary=contract' },
        body: '--contract--'
    });
    assertJsonContentType(namecard, `${fixture.runtime} namecard mutation`);
    await assertJsonResponse(
        namecard, 200, { msg: '上传成功，等待审核' },
        `${fixture.runtime} namecard mutation`
    );
    const afterNamecard = await fixture.snapshot();
    equal(afterNamecard.cards, afterNews.cards + 1, `${fixture.runtime} namecard row committed`);

    fixture.setUpload({
        fields: {},
        files: { images: [uploadedFile('front.png', 24, 3), uploadedFile('back.png', 24, 4)] }
    });
    await assertJsonResponse(
        await fixture.request('/api/uploadNameCard', {
            method: 'POST',
            headers: { 'Content-Type': 'multipart/form-data; boundary=contract' },
            body: '--contract--'
        }),
        200, { msg: '重复上传' }, `${fixture.runtime} duplicate namecard`
    );
    deepEqual(await fixture.snapshot(), afterNamecard,
        `${fixture.runtime} duplicate namecard removes generated objects`);

    const reactionPayload = JSON.stringify({ id: fixture.approvedCardId, emoji: '👍' });
    await assertJsonResponse(
        await fixture.request('/api/reactions', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: reactionPayload
        }),
        200, { ok: true }, `${fixture.runtime} reaction mutation`
    );
    await assertJsonResponse(
        await fixture.request('/api/emojis', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: reactionPayload
        }),
        200, { success: true }, `${fixture.runtime} emoji mutation`
    );
    await assertJsonResponse(
        await fixture.request(`/api/reactions?id=${fixture.approvedCardId}`),
        200, { '👍': 2 }, `${fixture.runtime} reaction read`
    );
    await assertJsonResponse(
        await fixture.request('/api/reactions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: fixture.approvedCardId, emoji: 'not-allowed' })
        }),
        400, { error: 'Unsupported reaction' }, `${fixture.runtime} rejected reaction`
    );

    const beforeDelete = await fixture.snapshot();
    fixture.failObjectDeletes(true);
    await assertJsonResponse(
        await fixture.request(`/api/events/${eventBody.id}`, { method: 'DELETE', headers: auth }),
        200, { success: true }, `${fixture.runtime} event delete with deferred cleanup`
    );
    const deferred = await fixture.snapshot();
    equal(deferred.events, beforeDelete.events - 1, `${fixture.runtime} event row deleted before media cleanup`);
    equal(deferred.objects, beforeDelete.objects, `${fixture.runtime} failed media cleanup preserves retry target`);
    equal(deferred.compensation.pending, beforeDelete.compensation.pending + 1,
        `${fixture.runtime} failed media cleanup is queued`);

    fixture.failObjectDeletes(false);
    await fixture.runCompensation();
    await fixture.runCompensation();
    const converged = await fixture.snapshot();
    equal(converged.events, deferred.events, `${fixture.runtime} compensation does not resurrect event`);
    equal(converged.objects, deferred.objects - 1, `${fixture.runtime} compensation removes media exactly once`);
    equal(converged.compensation.pending, 0, `${fixture.runtime} compensation queue drained`);
    equal(converged.compensation.completed >= 1, true, `${fixture.runtime} compensation completion audited`);

    const logs = await fixture.request('/api/admin/logs', { headers: auth });
    equal(logs.status, 200, `${fixture.runtime} audit listing status`);
    assertJsonContentType(logs, `${fixture.runtime} audit listing`);
    const logsBody = await json(logs, `${fixture.runtime} audit listing`);
    equal(logsBody.success, true, `${fixture.runtime} audit listing success`);
    equal(Array.isArray(logsBody.data), true, `${fixture.runtime} audit listing data`);
}

async function assertPostCommitMediaContract(fixture) {
    const auth = { Authorization: await fixture.opToken() };
    const post = (pathname, includeAuth = true) => fixture.request(pathname, {
        method: 'POST',
        headers: {
            ...(includeAuth ? auth : {}),
            'Content-Type': 'multipart/form-data; boundary=contract'
        },
        body: '--contract--'
    });
    const captureConsoleErrors = async (callback) => {
        const original = console.error;
        const entries = [];
        console.error = (...args) => entries.push(args);
        try {
            await callback();
        } finally {
            console.error = original;
        }
        return entries;
    };
    const assertLoggedErrors = (entries, messages, label) => {
        deepEqual(entries.map(([message]) => message), messages,
            `${fixture.runtime} ${label} log messages`);
        equal(entries.every(([, error]) => error instanceof Error), true,
            `${fixture.runtime} ${label} logs preserve error details`);
    };
    const assertPrivateServerError = async (response, expectedBody, label) => {
        equal(response.status, 500, `${fixture.runtime} ${label} status`);
        assertJsonContentType(response, `${fixture.runtime} ${label}`);
        const body = await json(response, `${fixture.runtime} ${label}`);
        deepEqual(body, expectedBody, `${fixture.runtime} ${label} body`);
        equal(JSON.stringify(body).includes('injected'), false,
            `${fixture.runtime} ${label} does not leak injected failure text`);
    };
    const before = await fixture.postCommitSnapshot();

    fixture.failBusinessInserts(true);
    let insertFailureLogs;
    try {
        insertFailureLogs = await captureConsoleErrors(async () => {
            fixture.setUpload({
                fields: { title: 'Pre-commit news', content: 'https://example.test/pre-commit-news' },
                files: { image: uploadedFile('pre-commit-news.png', 32, 61) }
            });
            await assertPrivateServerError(
                await post('/api/admin/news'), { success: false, msg: '服务器异常' },
                'pre-commit news failure'
            );
            fixture.setUpload({
                fields: { title: 'Pre-commit event', name: 'Producer', contact: 'contact@example.test' },
                files: { image: uploadedFile('pre-commit-event.png', 32, 62) }
            });
            await assertPrivateServerError(
                await post('/api/events'), { error: '服务器错误' },
                'pre-commit event failure'
            );
        });
    } finally {
        fixture.failBusinessInserts(false);
    }
    assertLoggedErrors(insertFailureLogs, ['Failed to create news', 'Failed to create event'],
        'pre-commit insert failures');
    deepEqual(await fixture.postCommitSnapshot(), before,
        `${fixture.runtime} pre-commit failures clean staged objects and rows`);

    fixture.failObjectPuts(true);
    let putFailureLogs;
    try {
        putFailureLogs = await captureConsoleErrors(async () => {
            fixture.setUpload({
                fields: {},
                files: {
                    images: [
                        uploadedFile('failed-card-front.png', 32, 67),
                        uploadedFile('failed-card-back.png', 32, 68)
                    ]
                }
            });
            await assertPrivateServerError(
                await post('/api/uploadNameCard', false), { msg: '服务器错误' },
                'unmarked object put failure'
            );
        });
    } finally {
        fixture.failObjectPuts(false);
    }
    assertLoggedErrors(putFailureLogs, ['Failed to upload namecard'], 'object put failure');
    deepEqual(await fixture.postCommitSnapshot(), before,
        `${fixture.runtime} object put failure leaves no staged objects or rows`);

    fixture.failObjectPublishes(true);
    let publishFailureLogs;
    try {
        publishFailureLogs = await captureConsoleErrors(async () => {
            fixture.setUpload({
                fields: { title: 'Committed news', content: 'https://example.test/committed-news' },
                files: { image: uploadedFile('committed-news.png', 32, 63) }
            });
            await assertJsonResponse(
                await post('/api/admin/news'), 200, { success: true },
                `${fixture.runtime} committed news survives publish failure`
            );
            const newsCommitted = await fixture.postCommitSnapshot();
            equal(newsCommitted.news, before.news + 1,
                `${fixture.runtime} publish failure creates one news row`);
            equal(newsCommitted.objects, before.objects + 2,
                `${fixture.runtime} news publish failure preserves both referenced objects`);
            if (newsCommitted.pendingPublications !== undefined && before.pendingPublications !== undefined) {
                equal(newsCommitted.pendingPublications, before.pendingPublications + 2,
                    `${fixture.runtime} news objects remain pending before recovery`);
            }
            fixture.setUpload({
                fields: { title: 'Committed event', name: 'Producer', contact: 'contact@example.test' },
                files: { image: uploadedFile('committed-event.png', 32, 64) }
            });
            const event = await post('/api/events');
            equal(event.status, 200, `${fixture.runtime} committed event survives publish failure`);
            const eventBody = await json(event, `${fixture.runtime} committed event publish failure`);
            equal(eventBody.success, true, `${fixture.runtime} committed event response success`);
            equal(Number.isSafeInteger(eventBody.id) && eventBody.id > 0, true,
                `${fixture.runtime} committed event response id`);
            const eventCommitted = await fixture.postCommitSnapshot();
            equal(eventCommitted.events, before.events + 1,
                `${fixture.runtime} publish failure creates one event row`);
            equal(eventCommitted.objects, before.objects + 3,
                `${fixture.runtime} event publish failure preserves its referenced object`);
            if (eventCommitted.pendingPublications !== undefined && before.pendingPublications !== undefined) {
                equal(eventCommitted.pendingPublications, before.pendingPublications + 1,
                    `${fixture.runtime} event stays pending after request recovery publishes news objects`);
            }
            if (eventCommitted.readyPublications !== undefined && before.readyPublications !== undefined) {
                equal(eventCommitted.readyPublications, before.readyPublications + 2,
                    `${fixture.runtime} event request recovery publishes both committed news objects`);
            }
        });
    } finally {
        fixture.failObjectPublishes(false);
    }
    assertLoggedErrors(publishFailureLogs, [
        'Failed to publish committed news media; recovery will retry',
        'Failed to publish committed event media; recovery will retry'
    ], 'publish failures');

    fixture.setUpload({
        fields: {},
        files: {
            images: [
                uploadedFile('committed-card-front.png', 32, 65),
                uploadedFile('committed-card-back.png', 32, 66)
            ]
        }
    });
    await assertJsonResponse(
        await post('/api/uploadNameCard', false), 200,
        { msg: '上传成功，等待审核' },
        `${fixture.runtime} namecard setup for committed deletion`
    );

    const committed = await fixture.postCommitSnapshot();
    equal(committed.news, before.news + 1,
        `${fixture.runtime} later recovery does not duplicate news rows`);
    equal(committed.events, before.events + 1,
        `${fixture.runtime} later recovery does not duplicate event rows`);
    equal(committed.cards, before.cards + 1,
        `${fixture.runtime} namecard setup creates one row`);
    equal(committed.objects, before.objects + 5,
        `${fixture.runtime} post-commit state preserves all referenced objects`);
    equal(committed.compensationPending, before.compensationPending,
        `${fixture.runtime} publish failures do not enqueue destructive cleanup`);
    if (committed.pendingPublications !== undefined && before.pendingPublications !== undefined) {
        equal(committed.pendingPublications, before.pendingPublications,
            `${fixture.runtime} later request recovery drains the committed event publication`);
    }
    if (committed.readyPublications !== undefined && before.readyPublications !== undefined) {
        equal(committed.readyPublications, before.readyPublications + 5,
            `${fixture.runtime} all referenced media is ready after request recovery`);
    }

    let recoverable = committed;
    if (fixture.recoverPublications) {
        await fixture.recoverPublications();
        recoverable = await fixture.postCommitSnapshot();
        equal(recoverable.news, committed.news,
            `${fixture.runtime} recovery does not duplicate news rows`);
        equal(recoverable.events, committed.events,
            `${fixture.runtime} recovery does not duplicate event rows`);
        equal(recoverable.cards, committed.cards,
            `${fixture.runtime} recovery does not alter namecard rows`);
        equal(recoverable.objects, committed.objects,
            `${fixture.runtime} recovery preserves referenced objects`);
        if (recoverable.pendingPublications !== undefined && committed.pendingPublications !== undefined) {
            equal(recoverable.pendingPublications, committed.pendingPublications,
                `${fixture.runtime} explicit recovery is idempotent after request recovery`);
        }
        if (recoverable.readyPublications !== undefined && committed.readyPublications !== undefined) {
            equal(recoverable.readyPublications, committed.readyPublications,
                `${fixture.runtime} explicit recovery preserves ready publications`);
        }
    }

    const targets = await fixture.mediaDeletionTargets();
    for (const [kind, id] of Object.entries(targets)) {
        equal(Number.isSafeInteger(id) && id > 0, true,
            `${fixture.runtime} ${kind} committed deletion target`);
    }
    fixture.failObjectDeletes(true);
    fixture.failCompensationEnqueues(true);
    let deleteFailureLogs;
    try {
        deleteFailureLogs = await captureConsoleErrors(async () => {
            await assertJsonResponse(
                await fixture.request(`/api/admin/news/${targets.news}`, { method: 'DELETE', headers: auth }),
                200, { success: true }, `${fixture.runtime} news delete survives cleanup double failure`
            );
            await assertJsonResponse(
                await fixture.request(`/api/events/${targets.event}`, { method: 'DELETE', headers: auth }),
                200, { success: true }, `${fixture.runtime} event delete survives cleanup double failure`
            );
            await assertJsonResponse(
                await fixture.request(`/api/admin/cards/${targets.card}`, { method: 'DELETE', headers: auth }),
                200, { success: true }, `${fixture.runtime} namecard delete survives cleanup double failure`
            );
        });
    } finally {
        fixture.failCompensationEnqueues(false);
        fixture.failObjectDeletes(false);
    }
    assertLoggedErrors(deleteFailureLogs, [
        'Failed to clean media for committed news deletion',
        'Failed to clean media for committed event deletion',
        'Failed to clean media for committed namecard deletion'
    ], 'committed deletion cleanup failures');
    const deleted = await fixture.postCommitSnapshot();
    equal(deleted.news, before.news,
        `${fixture.runtime} news row stays deleted after cleanup double failure`);
    equal(deleted.events, before.events,
        `${fixture.runtime} event row stays deleted after cleanup double failure`);
    equal(deleted.cards, before.cards,
        `${fixture.runtime} namecard row stays deleted after cleanup double failure`);
    equal(deleted.objects, recoverable.objects,
        `${fixture.runtime} failed cleanup leaves media available for operator recovery`);
    equal(deleted.compensationPending, recoverable.compensationPending,
        `${fixture.runtime} failed compensation enqueue does not report a phantom job`);
}

async function assertRouteUploadBoundaryContract(fixture) {
    const MiB = 1024 * 1024;
    const auth = { Authorization: await fixture.opToken() };
    const post = (path, headers = {}) => fixture.request(path, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'multipart/form-data; boundary=contract' },
        body: '--contract--'
    });

    let before = await fixture.uploadSnapshot();
    fixture.setUpload({ fields: {}, files: {
        images: [uploadedFile('front.png', 3 * MiB, 11), uploadedFile('back.png', 3 * MiB, 12)]
    } });
    await assertJsonResponse(
        await post('/api/uploadNameCard'), 200,
        { msg: '上传成功，等待审核' },
        `${fixture.runtime} namecard exact boundary`
    );
    let after = await fixture.uploadSnapshot();
    equal(after.cards, before.cards + 1, `${fixture.runtime} namecard exact boundary row`);
    equal(after.objects, before.objects + 2, `${fixture.runtime} namecard exact boundary objects`);

    before = after;
    fixture.setUpload({ fields: {}, files: {
        images: [uploadedFile('front-too-large.png', 3 * MiB + 1, 13), uploadedFile('back.png', 1, 14)]
    } });
    await assertJsonResponse(
        await post('/api/uploadNameCard'), 400, { msg: '文件过大' },
        `${fixture.runtime} namecard boundary plus one`
    );
    deepEqual(await fixture.uploadSnapshot(), before, `${fixture.runtime} rejected namecard leaves no residue`);

    fixture.setUpload({ fields: {}, files: {
        images: [uploadedFile('one.png', 1, 15), uploadedFile('two.png', 1, 16), uploadedFile('three.png', 1, 17)]
    } });
    await assertJsonResponse(
        await post('/api/uploadNameCard'), 200, { msg: '必须上传2张图片' },
        `${fixture.runtime} namecard excess file count`
    );
    deepEqual(await fixture.uploadSnapshot(), before, `${fixture.runtime} excess namecard leaves no residue`);

    fixture.setUpload({
        fields: { title: 'Boundary event', name: 'P', contact: 'p@example.test' },
        files: { image: uploadedFile('event.png', 3 * MiB, 21) }
    });
    const event = await post('/api/events', auth);
    equal(event.status, 200, `${fixture.runtime} event exact boundary status`);
    equal((await json(event, `${fixture.runtime} event exact boundary`)).success, true,
        `${fixture.runtime} event exact boundary body`);
    after = await fixture.uploadSnapshot();
    equal(after.events, before.events + 1, `${fixture.runtime} event exact boundary row`);
    equal(after.objects, before.objects + 1, `${fixture.runtime} event exact boundary object`);

    before = after;
    fixture.setUpload({ fields: { title: 'Too large event' },
        files: { image: uploadedFile('event-too-large.png', 3 * MiB + 1, 22) } });
    await assertJsonResponse(
        await post('/api/events', auth), 400, { error: '必须上传一张图片' },
        `${fixture.runtime} event boundary plus one`
    );
    deepEqual(await fixture.uploadSnapshot(), before, `${fixture.runtime} rejected event leaves no residue`);

    fixture.setUpload({ fields: { title: 'No image news', content: 'https://example.test/no-image' }, files: {} });
    await assertJsonResponse(await post('/api/admin/news', auth), 200, { success: true },
        `${fixture.runtime} zero-image news`);
    after = await fixture.uploadSnapshot();
    equal(after.news, before.news + 1, `${fixture.runtime} zero-image news row`);
    equal(after.objects, before.objects, `${fixture.runtime} zero-image news objects`);

    before = after;
    fixture.setUpload({ fields: { title: 'One image news', content: 'https://example.test/one-image' },
        files: { image: uploadedFile('news.png', 10 * MiB, 31) } });
    await assertJsonResponse(await post('/api/admin/news', auth), 200, { success: true },
        `${fixture.runtime} news exact boundary`);
    after = await fixture.uploadSnapshot();
    equal(after.news, before.news + 1, `${fixture.runtime} news exact boundary row`);
    equal(after.objects, before.objects + 2, `${fixture.runtime} news original and thumbnail`);

    before = after;
    fixture.setUpload({ fields: { title: 'Large news', content: 'https://example.test/large' },
        files: { image: uploadedFile('news-too-large.png', 10 * MiB + 1, 32) } });
    await assertJsonResponse(
        await post('/api/admin/news', auth), 400, { success: false, msg: '图片过大' },
        `${fixture.runtime} news boundary plus one`
    );
    deepEqual(await fixture.uploadSnapshot(), before, `${fixture.runtime} rejected news leaves no residue`);

    const chronicleFiles = Array.from({ length: 5 }, (_, index) =>
        uploadedFile(`chronicle-${index}.png`, 5 * MiB, 41 + index));
    fixture.setUpload({ fields: { activityId: `${fixture.runtime.toLowerCase()}-boundary`, username: 'Boundary' },
        files: { images: chronicleFiles } });
    await assertJsonResponse(
        await post('/eventchronicle/upload', { 'Idempotency-Key': `${fixture.runtime}-five-files` }),
        200, { success: true, count: 5 }, `${fixture.runtime} Chronicle exact boundary`
    );
    after = await fixture.uploadSnapshot();
    equal(after.chronicle, before.chronicle + 5, `${fixture.runtime} Chronicle exact boundary rows`);
    equal(after.objects, before.objects + 5, `${fixture.runtime} Chronicle exact boundary objects`);

    before = after;
    fixture.setUpload({ fields: { activityId: `${fixture.runtime.toLowerCase()}-boundary-large`, username: 'Boundary' },
        files: { images: [uploadedFile('chronicle-too-large.png', 5 * MiB + 1, 50)] } });
    await assertJsonResponse(
        await post('/eventchronicle/upload', { 'Idempotency-Key': `${fixture.runtime}-large-file` }),
        400, { success: false, error: '文件过大' },
        `${fixture.runtime} Chronicle boundary plus one`
    );
    deepEqual(await fixture.uploadSnapshot(), before, `${fixture.runtime} rejected Chronicle leaves no residue`);
}

async function assertChronicleRateContract(fixture) {
    const replayKey = `${fixture.runtime.toLowerCase()}-replay-key`;
    for (let index = 0; index < 60; index += 1) {
        await assertJsonResponse(
            await fixture.uploadChronicle(replayKey, 'replay-client', 'replay-activity'),
            200, { success: true, count: 1 }, `${fixture.runtime} Chronicle replay ${index + 1}`
        );
    }
    const replay = await fixture.rateSnapshot('replay-client');
    equal(replay.count, 1, `${fixture.runtime} replay consumes one fingerprint identity`);
    equal(replay.writeCount, 1, `${fixture.runtime} replay consumes one write-key identity`);
    equal(replay.attemptCount, 60, `${fixture.runtime} replay attempts consume request quota`);
    equal(replay.records, 1, `${fixture.runtime} replay keeps one Chronicle record`);
    equal(replay.objects, 1, `${fixture.runtime} replay keeps one Chronicle object`);

    const attemptBlockedBody = unreadJsonBody();
    const attemptBlocked = await fixture.uploadChronicle(
        replayKey,
        'replay-client',
        'replay-activity',
        attemptBlockedBody.body
    );
    await assertJsonResponse(attemptBlocked, 429, { error: 'Too many requests' },
        `${fixture.runtime} Chronicle attempt 61 blocked`);
    const afterAttemptBlocked = await fixture.rateSnapshot('replay-client');
    equal(attemptBlockedBody.pulls(), 0,
        `${fixture.runtime} attempt rejection leaves multipart body unread`);
    equal(afterAttemptBlocked.parserCalls, replay.parserCalls,
        `${fixture.runtime} attempt rejection runs before parser`);
    equal(afterAttemptBlocked.storageMutations, replay.storageMutations,
        `${fixture.runtime} attempt rejection runs before storage`);
    equal(afterAttemptBlocked.writeCount, 1,
        `${fixture.runtime} attempt rejection does not spend write-key quota`);

    for (let index = 1; index <= 30; index += 1) {
        const response = await fixture.uploadChronicle(
            `${fixture.runtime.toLowerCase()}-distinct-${index}`,
            'distinct-client', `distinct-activity-${index}`
        );
        equal(response.status, 200, `${fixture.runtime} distinct upload ${index} status`);
    }
    const beforeBlocked = await fixture.rateSnapshot('distinct-client');
    const writeBlockedBody = unreadJsonBody();
    const blocked = await fixture.uploadChronicle(
        `${fixture.runtime.toLowerCase()}-distinct-31`,
        'distinct-client',
        'distinct-activity-31',
        writeBlockedBody.body
    );
    await assertJsonResponse(blocked, 429, { error: 'Too many requests' },
        `${fixture.runtime} distinct upload 31 blocked`);
    const afterBlocked = await fixture.rateSnapshot('distinct-client');
    equal(writeBlockedBody.pulls(), 0,
        `${fixture.runtime} write-key rejection leaves multipart body unread`);
    equal(afterBlocked.parserCalls, beforeBlocked.parserCalls,
        `${fixture.runtime} write-key rate limit runs before parser`);
    equal(afterBlocked.storageMutations, beforeBlocked.storageMutations,
        `${fixture.runtime} rate limit runs before storage`);
    equal(afterBlocked.records, beforeBlocked.records,
        `${fixture.runtime} blocked upload creates no Chronicle row`);
    equal(afterBlocked.objects, beforeBlocked.objects,
        `${fixture.runtime} blocked upload creates no object`);
    equal(afterBlocked.writeCount, 30,
        `${fixture.runtime} rejected distinct key is not persisted`);
    equal(afterBlocked.attemptCount, 31,
        `${fixture.runtime} rejected distinct key still spends attempt quota`);
}

async function assertConcurrentRateLimiterContract(fixture) {
    const runBatches = async (operations, size = 6) => {
        const results = [];
        for (let index = 0; index < operations.length; index += size) {
            results.push(...await Promise.all(operations.slice(index, index + size).map((operation) => operation())));
        }
        return results;
    };
    const replay = await runBatches(Array.from({ length: 31 }, () => () =>
        fixture.consume('same-client', 'same-identity')));
    equal(replay.every((result) => result.allowed), true,
        `${fixture.runtime} concurrent same identity remains replayable`);
    equal(await fixture.count('same-client'), 1,
        `${fixture.runtime} concurrent same identity is persisted once`);

    const distinct = await runBatches(Array.from({ length: 31 }, (_, index) => () =>
        fixture.consume('distinct-client', `identity-${index}`)));
    equal(distinct.filter((result) => result.allowed).length, 30,
        `${fixture.runtime} concurrent distinct identities enforce hard cap`);
    equal(distinct.filter((result) => !result.allowed).length, 1,
        `${fixture.runtime} concurrent distinct overflow is rejected`);
    equal(await fixture.count('distinct-client'), 30,
        `${fixture.runtime} rejected distinct overflow is not persisted`);
}

module.exports = {
    assertAbuseProtectionContract,
    assertCoreAuthContract,
    assertCoreMutationContract,
    assertPostCommitMediaContract,
    assertChronicleRateContract,
    assertConcurrentRateLimiterContract,
    assertIdempotentReplayContract,
    assertJsonResponse,
    assertMediaRangeContract,
    assertMultipartParserContract,
    assertReactionContract,
    assertRejectedJwtContract,
    assertRouteUploadBoundaryContract,
    decodeJwtPart,
    deepEqual,
    equal
};
