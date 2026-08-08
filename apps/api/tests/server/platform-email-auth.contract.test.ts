import assert from 'node:assert/strict';
import { createHash, pbkdf2Sync, randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { createHonoApp } from '@/app';
import { SqlPlatformAccountRepository } from '@/infra/db/repositories/platform-account-repository';
import { PostgresConnection } from '@/infra/db/postgresql/connection';
import type { ManagedSqlDatabase, SqlSchemaStrategy } from '@/infra/db/sql/database';
import { BcryptPasswordVerifier } from '@/infra/security/bcrypt/password-verifier';
import { HmacPlatformTokenService } from '@/infra/security/hmac/platform-token-service';
import { isMigratedPbkdf2Parameters } from '@/domains/platform-auth/platform-email-input';
import type {
    NewPlatformEmailAccountInput,
    PlatformAccountStatus
} from '@/ports/repositories';
import type {
    PlatformEmailSender,
    PlatformEmailVerificationMessage
} from '@/ports/email';
import type { RuntimeServices } from '@/ports/runtime-services';
import {
    createPostgresTestHarness,
    postgresIntegrationEnabled
} from '../integration/postgres-harness';

const PLATFORM_SECRET = 'platform-email-auth-test-secret-at-least-thirty-two-bytes';
const PASSWORD = 'correct horse battery staple';
const LEGACY_PASSWORD = 'old-pass';
const ACCESS_COOKIE = 'ims_platform_access';
const REFRESH_COOKIE = 'ims_platform_refresh';
const CSRF_COOKIE = 'ims_platform_csrf';
const PLATFORM_COOKIE_NAMES = [ACCESS_COOKIE, CSRF_COOKIE, REFRESH_COOKIE];

const initializedPostgresSchema: SqlSchemaStrategy = {
    initializeCore: async () => undefined,
    initializePlatform: async () => undefined,
    initializeFudaba: async () => undefined,
    initializeStory: async () => undefined
};

interface Fixture {
    app: ReturnType<typeof createHonoApp>;
    database: ManagedSqlDatabase;
    databaseUrl?: string;
    repository: SqlPlatformAccountRepository;
    emailSender: CapturingPlatformEmailSender;
}

class CapturingPlatformEmailSender implements PlatformEmailSender {
    available = true;
    fail = false;
    beforeResult: Promise<void> | null = null;
    onSend: (() => void) | null = null;
    readonly messages: PlatformEmailVerificationMessage[] = [];

    async sendRegistrationVerification(
        message: PlatformEmailVerificationMessage
    ): Promise<void> {
        this.messages.push(message);
        this.onSend?.();
        if (this.beforeResult) await this.beforeResult;
        if (this.fail) throw new Error('Injected email delivery failure');
    }
}

function appWithPlatformEmail(
    repository: SqlPlatformAccountRepository,
    emailSender: CapturingPlatformEmailSender
): ReturnType<typeof createHonoApp> {
    const runtime = {
        platformAccounts: repository,
        passwords: new BcryptPasswordVerifier(),
        platformTokens: new HmacPlatformTokenService(PLATFORM_SECRET),
        platformEmailSender: emailSender,
        config: { cookieSecure: false, clientAddressSource: 'direct' }
    } as unknown as RuntimeServices;
    return createHonoApp(() => runtime);
}

function emailAccount(
    email: string,
    passwordHash: string,
    status: PlatformAccountStatus = 'active'
): NewPlatformEmailAccountInput {
    const now = Date.now();
    return {
        id: randomUUID(),
        status,
        tokenVersion: 0,
        createdAt: now,
        updatedAt: now,
        deletedAt: status === 'deleted' ? now : null,
        profile: {
            displayName: `Producer ${email}`,
            avatarObjectKey: null,
            avatarExternalUrl: null,
            homeCity: null,
            bio: '',
            updatedAt: now
        },
        credential: {
            normalizedEmail: email,
            algorithm: 'bcrypt',
            parametersJson: '{"cost":12}',
            passwordHash,
            createdAt: now,
            updatedAt: now
        }
    };
}

async function createFixture(
    t: TestContext,
    dialect: 'sqlite' | 'postgresql' = 'postgresql'
): Promise<Fixture> {
    const harness = await createPostgresTestHarness();
    t.after(() => harness.close());
    const repository = new SqlPlatformAccountRepository(
        harness.connection,
        initializedPostgresSchema
    );
    await repository.initialize();
    const emailSender = new CapturingPlatformEmailSender();
    return {
        app: appWithPlatformEmail(repository, emailSender),
        database: harness.connection,
        databaseUrl: harness.databaseUrl,
        repository,
        emailSender
    };
}

function jsonRequest(pathname: string, body: unknown, headers: HeadersInit = {}): Request {
    return new Request(`http://ims.test${pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body)
    });
}

function setCookies(response: Response): string[] {
    return (response.headers as Headers & { getSetCookie(): string[] }).getSetCookie();
}

function assertPlatformCookies(response: Response): void {
    const cookies = setCookies(response);
    assert.deepEqual(
        cookies.map((cookie) => cookie.split('=', 1)[0]).sort(),
        [...PLATFORM_COOKIE_NAMES].sort()
    );
    for (const cookie of cookies) {
        assert.match(cookie, /SameSite=Lax/i);
        assert.doesNotMatch(cookie, /ims_admin_|refresh_token|csrf_token|^token=/i);
    }
}

function assertPrivateAuthResponse(response: Response): void {
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const vary = response.headers.get('vary') || '';
    assert.match(vary, /Authorization/i);
    assert.match(vary, /Cookie/i);
}

async function requestVerificationCode(
    fixture: Fixture,
    email: string
): Promise<string> {
    const response = await fixture.app.request(jsonRequest(
        '/api/platform/auth/register/verification-code',
        { email }
    ));
    assert.equal(response.status, 202, await response.clone().text());
    assert.deepEqual(await response.json(), {
        success: true,
        retryAfterSeconds: 60
    });
    assertPrivateAuthResponse(response);
    const message = fixture.emailSender.messages.at(-1);
    assert.ok(message);
    assert.match(message.code, /^\d{6}$/);
    return message.code;
}

async function assertFailedResendPreservesOldCode(
    t: TestContext,
    dialect: 'sqlite' | 'postgresql'
): Promise<void> {
    const fixture = await createFixture(t, dialect);
    const email = `failed-resend-${dialect}@example.test`;
    const expiredAt = Date.now();
    await fixture.database.prepare(
        `INSERT INTO platform_email_verification_codes
            (normalized_email, code_hash, expires_at, resend_after,
             attempts_remaining, consumed_token, created_at, updated_at)
         VALUES (?, ?, ?, ?, 5, NULL, ?, ?)`
    ).bind(
        `expired-${dialect}@example.test`,
        'e'.repeat(64),
        expiredAt,
        expiredAt - 1,
        expiredAt - 2,
        expiredAt - 2
    ).run();
    const oldCode = await requestVerificationCode(fixture, email);
    assert.equal(await fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM platform_email_verification_codes
         WHERE normalized_email=?`
    ).bind(`expired-${dialect}@example.test`).first<number>('count'), 0);
    const original = await fixture.database.prepare(
        `SELECT code_hash, attempts_remaining
         FROM platform_email_verification_codes WHERE normalized_email=?`
    ).bind(email).first<{ code_hash: string; attempts_remaining: number }>();
    assert.ok(original);
    await fixture.database.prepare(
        `UPDATE platform_email_verification_codes
         SET resend_after=created_at WHERE normalized_email=?`
    ).bind(email).run();

    let registrationApp = fixture.app;
    let siblingRepository: SqlPlatformAccountRepository | null = null;
    if (dialect === 'postgresql') {
        assert.ok(fixture.databaseUrl);
        const siblingConnection = PostgresConnection.create({
            connectionString: fixture.databaseUrl,
            maxConnections: 2,
            idleTimeoutMs: 5_000,
            connectionTimeoutMs: 5_000,
            statementTimeoutMs: 30_000,
            idleInTransactionTimeoutMs: 30_000
        });
        siblingRepository = new SqlPlatformAccountRepository(
            siblingConnection,
            initializedPostgresSchema
        );
        await siblingRepository.initialize();
        t.after(() => siblingRepository?.close().catch(() => undefined));
        registrationApp = appWithPlatformEmail(
            siblingRepository,
            new CapturingPlatformEmailSender()
        );
    }

    let releaseDelivery = (): void => undefined;
    let markDeliveryStarted = (): void => undefined;
    const deliveryGate = new Promise<void>((resolve) => {
        releaseDelivery = resolve;
    });
    const deliveryStarted = new Promise<void>((resolve) => {
        markDeliveryStarted = resolve;
    });
    t.after(() => releaseDelivery());
    fixture.emailSender.fail = true;
    fixture.emailSender.beforeResult = deliveryGate;
    fixture.emailSender.onSend = markDeliveryStarted;
    const resendPromise = fixture.app.request(jsonRequest(
        '/api/platform/auth/register/verification-code',
        { email }
    ));
    await deliveryStarted;

    const staged = await fixture.database.prepare(
        `SELECT code_hash, attempts_remaining, pending_token, pending_code_hash
         FROM platform_email_verification_codes WHERE normalized_email=?`
    ).bind(email).first<{
        code_hash: string;
        attempts_remaining: number;
        pending_token: string | null;
        pending_code_hash: string | null;
    }>();
    assert.ok(staged);
    assert.equal(staged.code_hash, original.code_hash);
    assert.match(staged.pending_token || '', /^[a-f0-9]{64}$/);
    assert.match(staged.pending_code_hash || '', /^[a-f0-9]{64}$/);
    assert.notEqual(staged.pending_code_hash, staged.code_hash);

    const wrongCode = oldCode === '000000' ? '000001' : '000000';
    const wrongRegistration = await registrationApp.request(jsonRequest(
        '/api/platform/auth/register',
        {
            email,
            displayName: 'Concurrent Producer',
            password: PASSWORD,
            code: wrongCode
        }
    ));
    assert.equal(wrongRegistration.status, 400);
    assert.deepEqual(await wrongRegistration.json(), {
        success: false,
        code: 'PLATFORM_EMAIL_VERIFICATION_INVALID'
    });

    releaseDelivery();
    const failedResend = await resendPromise;
    assert.equal(failedResend.status, 503);
    assert.deepEqual(await failedResend.json(), {
        success: false,
        code: 'PLATFORM_EMAIL_VERIFICATION_UNAVAILABLE'
    });
    const restored = await fixture.database.prepare(
        `SELECT code_hash, attempts_remaining, pending_token, pending_code_hash
         FROM platform_email_verification_codes WHERE normalized_email=?`
    ).bind(email).first<{
        code_hash: string;
        attempts_remaining: number;
        pending_token: string | null;
        pending_code_hash: string | null;
    }>();
    assert.deepEqual(restored, {
        code_hash: original.code_hash,
        attempts_remaining: original.attempts_remaining - 1,
        pending_token: null,
        pending_code_hash: null
    });

    const registered = await registrationApp.request(jsonRequest(
        '/api/platform/auth/register',
        {
            email,
            displayName: 'Concurrent Producer',
            password: PASSWORD,
            code: oldCode
        }
    ));
    assert.equal(registered.status, 201, await registered.clone().text());
    await siblingRepository?.close();
}

async function assertRegistrationAndLogin(
    t: TestContext,
    dialect: 'sqlite' | 'postgresql'
): Promise<void> {
    const fixture = await createFixture(t, dialect);
    const { app, database } = fixture;
    const registrationCode = await requestVerificationCode(
        fixture,
        ' Producer@Example.Test '
    );
    const register = await app.request(jsonRequest('/api/platform/auth/register', {
        email: ' Producer@Example.Test ',
        displayName: ' Producer One ',
        password: ` ${PASSWORD} `,
        code: registrationCode
    }, {
        Cookie: 'ims_admin_access=backoffice-must-survive; ims_admin_csrf=unchanged'
    }));
    assert.equal(register.status, 201, await register.clone().text());
    assert.deepEqual(await register.clone().json(), {
        success: true,
        account: {
            id: (await register.clone().json() as { account: { id: string } }).account.id,
            status: 'active'
        },
        profile: {
            displayName: 'Producer One',
            avatarUrl: null,
            homeCity: null,
            bio: ''
        }
    });
    assertPlatformCookies(register);
    assertPrivateAuthResponse(register);

    const stored = await database.prepare(
        `SELECT accounts.id, profiles.display_name, credentials.normalized_email,
                credentials.algorithm, credentials.parameters_json,
                credentials.salt, credentials.password_hash
         FROM platform_accounts accounts
         JOIN platform_profiles profiles ON profiles.account_id=accounts.id
         JOIN platform_email_credentials credentials
           ON credentials.account_id=accounts.id`
    ).first<{
        id: string;
        display_name: string;
        normalized_email: string;
        algorithm: string;
        parameters_json: string;
        salt: string | null;
        password_hash: string;
    }>();
    assert.ok(stored);
    assert.equal(stored.display_name, 'Producer One');
    assert.equal(stored.normalized_email, 'producer@example.test');
    assert.equal(stored.algorithm, 'bcrypt');
    assert.equal(stored.parameters_json, '{"cost":12,"normalization":"trim"}');
    assert.equal(stored.salt, null);
    assert.match(stored.password_hash, /^\$2[aby]\$12\$/);

    const login = await app.request(jsonRequest('/api/platform/auth/login', {
        email: ' PRODUCER@example.test ',
        password: ` ${PASSWORD} `
    }));
    assert.equal(login.status, 200, await login.clone().text());
    assert.equal((await login.json() as { account: { id: string } }).account.id, stored.id);
    assertPlatformCookies(login);
    assertPrivateAuthResponse(login);

    const duplicateCode = await requestVerificationCode(
        fixture,
        'duplicate@example.test'
    );
    const [duplicateA, duplicateB] = await Promise.all([
        app.request(jsonRequest('/api/platform/auth/register', {
            email: 'duplicate@example.test',
            displayName: 'Duplicate A',
            password: PASSWORD,
            code: duplicateCode
        })),
        app.request(jsonRequest('/api/platform/auth/register', {
            email: 'DUPLICATE@example.test',
            displayName: 'Duplicate B',
            password: PASSWORD,
            code: duplicateCode
        }))
    ]);
    assert.deepEqual(
        [duplicateA.status, duplicateB.status].sort((a, b) => a - b),
        [201, 400]
    );
    assert.equal(await database.prepare(
        "SELECT COUNT(*) AS count FROM platform_email_credentials WHERE normalized_email=?"
    ).bind('duplicate@example.test').first<number>('count'), 1);
    assert.equal(await database.prepare(
        'SELECT COUNT(*) AS count FROM platform_accounts'
    ).first<number>('count'), 2);
    assert.equal(await database.prepare(
        'SELECT COUNT(*) AS count FROM platform_profiles'
    ).first<number>('count'), 2);
}

test('registration verification is hashed, cooled down, atomically consumed, and single use', async (t) => {
    const fixture = await createFixture(t);
    const email = 'verified@example.test';
    const code = await requestVerificationCode(fixture, email);
    const stored = await fixture.database.prepare(
        `SELECT code_hash, expires_at, resend_after, attempts_remaining, consumed_token
         FROM platform_email_verification_codes WHERE normalized_email=?`
    ).bind(email).first<{
        code_hash: string;
        expires_at: number;
        resend_after: number;
        attempts_remaining: number;
        consumed_token: string | null;
    }>();
    assert.ok(stored);
    assert.match(stored.code_hash, /^[a-f0-9]{64}$/);
    assert.notEqual(stored.code_hash, code);
    assert.equal(stored.attempts_remaining, 5);
    assert.equal(stored.consumed_token, null);
    assert.ok(stored.expires_at > stored.resend_after);

    const cooldown = await fixture.app.request(jsonRequest(
        '/api/platform/auth/register/verification-code',
        { email: ' VERIFIED@example.test ' }
    ));
    assert.equal(cooldown.status, 429);
    const cooldownBody = await cooldown.json() as {
        success: boolean;
        code: string;
        retryAfterSeconds: number;
    };
    assert.deepEqual(cooldownBody, {
        success: false,
        code: 'PLATFORM_EMAIL_VERIFICATION_COOLDOWN',
        retryAfterSeconds: cooldownBody.retryAfterSeconds
    });
    assert.ok(cooldownBody.retryAfterSeconds >= 59);
    assert.ok(cooldownBody.retryAfterSeconds <= 60);
    assert.equal(cooldown.headers.get('retry-after'), String(cooldownBody.retryAfterSeconds));
    assert.equal(fixture.emailSender.messages.length, 1);

    const wrongCode = code === '000000' ? '000001' : '000000';
    const wrong = await fixture.app.request(jsonRequest('/api/platform/auth/register', {
        email,
        displayName: 'Verified Producer',
        password: PASSWORD,
        code: wrongCode
    }));
    assert.equal(wrong.status, 400);
    assert.deepEqual(await wrong.json(), {
        success: false,
        code: 'PLATFORM_EMAIL_VERIFICATION_INVALID'
    });
    assert.equal(await fixture.database.prepare(
        `SELECT attempts_remaining FROM platform_email_verification_codes
         WHERE normalized_email=?`
    ).bind(email).first<number>('attempts_remaining'), 4);

    const registered = await fixture.app.request(jsonRequest('/api/platform/auth/register', {
        email,
        displayName: 'Verified Producer',
        password: PASSWORD,
        code
    }));
    assert.equal(registered.status, 201, await registered.clone().text());
    assert.equal(await fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM platform_email_verification_codes
         WHERE normalized_email=?`
    ).bind(email).first<number>('count'), 0);

    const replay = await fixture.app.request(jsonRequest('/api/platform/auth/register', {
        email: 'second@example.test',
        displayName: 'Replay Producer',
        password: PASSWORD,
        code
    }));
    assert.equal(replay.status, 400);
    assert.equal(await fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM platform_email_credentials
         WHERE normalized_email='second@example.test'`
    ).first<number>('count'), 0);
});

test('verification delivery fails closed and revokes only the unsent code', async (t) => {
    const fixture = await createFixture(t);
    fixture.emailSender.available = false;
    const unavailable = await fixture.app.request(jsonRequest(
        '/api/platform/auth/register/verification-code',
        { email: 'disabled@example.test' }
    ));
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), {
        success: false,
        code: 'PLATFORM_EMAIL_VERIFICATION_UNAVAILABLE'
    });
    assert.equal(fixture.emailSender.messages.length, 0);

    fixture.emailSender.available = true;
    fixture.emailSender.fail = true;
    const failed = await fixture.app.request(jsonRequest(
        '/api/platform/auth/register/verification-code',
        { email: 'failed@example.test' }
    ));
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), {
        success: false,
        code: 'PLATFORM_EMAIL_VERIFICATION_UNAVAILABLE'
    });
    assert.equal(await fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM platform_email_verification_codes
         WHERE normalized_email='failed@example.test'`
    ).first<number>('count'), 0);

    fixture.emailSender.fail = false;
    const retry = await fixture.app.request(jsonRequest(
        '/api/platform/auth/register/verification-code',
        { email: 'failed@example.test' }
    ));
    assert.equal(retry.status, 202, await retry.clone().text());
});

test('session fencing returns account unavailable without writing cookies', async (t) => {
    const fixture = await createFixture(t);
    const email = 'session-fence@example.test';
    const code = await requestVerificationCode(fixture, email);
    fixture.repository.createRefreshSession = async () => false;

    const registration = await fixture.app.request(jsonRequest(
        '/api/platform/auth/register',
        {
            email,
            displayName: 'Session Fence Producer',
            password: PASSWORD,
            code
        }
    ));
    assert.equal(registration.status, 403);
    assert.deepEqual(await registration.json(), {
        success: false,
        code: 'PLATFORM_ACCOUNT_UNAVAILABLE'
    });
    assert.equal(setCookies(registration).length, 0);

    const login = await fixture.app.request(jsonRequest('/api/platform/auth/login', {
        email,
        password: PASSWORD
    }));
    assert.equal(login.status, 403);
    assert.deepEqual(await login.json(), {
        success: false,
        code: 'PLATFORM_ACCOUNT_UNAVAILABLE'
    });
    assert.equal(setCookies(login).length, 0);
    assert.equal(await fixture.database.prepare(
        'SELECT COUNT(*) AS count FROM platform_refresh_sessions'
    ).first<number>('count'), 0);
});

test('login returns one generic credential error and rejects blocked account states', async (t) => {
    const { app, repository } = await createFixture(t);
    const passwordHash = await new BcryptPasswordVerifier().hash(PASSWORD);
    for (const status of ['active', 'suspended', 'deleted'] as const) {
        const result = await repository.createEmailAccount(emailAccount(
            `${status}@example.test`,
            passwordHash,
            status
        ));
        assert.equal(result.status, 'created');
    }

    const wrong = await app.request(jsonRequest('/api/platform/auth/login', {
        email: 'active@example.test',
        password: 'this password is wrong'
    }));
    const missing = await app.request(jsonRequest('/api/platform/auth/login', {
        email: 'missing@example.test',
        password: 'this password is wrong'
    }));
    assert.equal(wrong.status, 401);
    assert.equal(missing.status, 401);
    const wrongBody = await wrong.json();
    const missingBody = await missing.json();
    assert.deepEqual(wrongBody, missingBody);
    assert.deepEqual(missingBody, {
        success: false,
        code: 'PLATFORM_CREDENTIALS_INVALID'
    });

    for (const [status, code] of [
        ['suspended', 'PLATFORM_ACCOUNT_SUSPENDED'],
        ['deleted', 'PLATFORM_ACCOUNT_UNAVAILABLE']
    ] as const) {
        const response = await app.request(jsonRequest('/api/platform/auth/login', {
            email: `${status}@example.test`,
            password: PASSWORD
        }));
        assert.equal(response.status, 403);
        assert.deepEqual(await response.json(), { success: false, code });
        assert.equal(setCookies(response).length, 0);
    }
});

test('migrated PBKDF2 credential logs in once and upgrades with bcrypt CAS', async (t) => {
    const { app, database, repository } = await createFixture(t);
    const now = Date.now();
    const accountId = randomUUID();
    await repository.createAccountWithProfile({
        id: accountId,
        status: 'active',
        tokenVersion: 0,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        profile: {
            displayName: 'Migrated Producer',
            avatarObjectKey: null,
            avatarExternalUrl: null,
            homeCity: null,
            bio: '',
            updatedAt: now
        }
    });
    const salt = 'legacy-fudaba-salt';
    const legacyHash = pbkdf2Sync(
        LEGACY_PASSWORD,
        salt,
        100_000,
        32,
        'sha256'
    ).toString('hex');
    await database.prepare(
        `INSERT INTO platform_email_credentials
            (normalized_email, account_id, algorithm, parameters_json, salt,
             password_hash, created_at, updated_at)
         VALUES (?, ?, 'pbkdf2-sha256', ?, ?, ?, ?, ?)`
    ).bind(
        'legacy@domain..test',
        accountId,
        JSON.stringify({
            iterations: 100_000,
            hash: 'sha256',
            keyLength: 32,
            encoding: 'hex',
            saltEncoding: 'utf8'
        }),
        salt,
        legacyHash,
        now,
        now
    ).run();

    const response = await app.request(jsonRequest('/api/platform/auth/login', {
        email: ' LEGACY@DOMAIN..TEST ',
        password: ` ${LEGACY_PASSWORD} `
    }));
    assert.equal(response.status, 200, await response.clone().text());
    const upgraded = await database.prepare(
        `SELECT algorithm, parameters_json, salt, password_hash, updated_at
         FROM platform_email_credentials WHERE normalized_email=?`
    ).bind('legacy@domain..test').first<{
        algorithm: string;
        parameters_json: string;
        salt: string | null;
        password_hash: string;
        updated_at: number;
    }>();
    assert.ok(upgraded);
    assert.equal(upgraded.algorithm, 'bcrypt');
    assert.equal(
        upgraded.parameters_json,
        '{"cost":12,"normalization":"fudaba-trim"}'
    );
    assert.equal(upgraded.salt, null);
    assert.match(upgraded.password_hash, /^\$2[aby]\$12\$/);
    assert.ok(upgraded.updated_at >= now);
    assert.equal(
        await new BcryptPasswordVerifier().verify(LEGACY_PASSWORD, upgraded.password_hash),
        true
    );
    assert.equal(await repository.upgradeEmailCredentialToBcrypt({
        normalizedEmail: 'legacy@domain..test',
        expectedAlgorithm: 'pbkdf2-sha256',
        expectedPasswordHash: legacyHash,
        expectedUpdatedAt: now,
        passwordHash: 'must-not-win',
        parametersJson: '{"cost":12}',
        updatedAt: Date.now()
    }), false);
});

test('long migrated PBKDF2 passwords authenticate without unsafe bcrypt upgrade', async (t) => {
    const { app, database, repository } = await createFixture(t);
    const now = Date.now();
    const accountId = randomUUID();
    const longPassword = '\u5236'.repeat(25);
    assert.ok(Buffer.byteLength(longPassword, 'utf8') > 72);
    await repository.createAccountWithProfile({
        id: accountId,
        status: 'active',
        tokenVersion: 0,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        profile: {
            displayName: 'Long Password Producer',
            avatarObjectKey: null,
            avatarExternalUrl: null,
            homeCity: null,
            bio: '',
            updatedAt: now
        }
    });
    const salt = 'legacy-long-password-salt';
    const passwordHash = pbkdf2Sync(
        longPassword,
        salt,
        100_000,
        32,
        'sha256'
    ).toString('hex');
    await database.prepare(
        `INSERT INTO platform_email_credentials
            (normalized_email, account_id, algorithm, parameters_json, salt,
             password_hash, created_at, updated_at)
         VALUES (?, ?, 'pbkdf2-sha256', ?, ?, ?, ?, ?)`
    ).bind(
        'long@example.test',
        accountId,
        JSON.stringify({
            iterations: 100_000,
            hash: 'sha256',
            keyLength: 32,
            encoding: 'hex',
            saltEncoding: 'utf8'
        }),
        salt,
        passwordHash,
        now,
        now
    ).run();

    const response = await app.request(jsonRequest('/api/platform/auth/login', {
        email: ' LONG@example.test ',
        password: ` ${longPassword} `
    }));
    assert.equal(response.status, 200, await response.clone().text());
    const credential = await database.prepare(
        `SELECT algorithm, salt, password_hash FROM platform_email_credentials
         WHERE normalized_email='long@example.test'`
    ).first<{ algorithm: string; salt: string | null; password_hash: string }>();
    assert.deepEqual(credential, {
        algorithm: 'pbkdf2-sha256',
        salt,
        password_hash: passwordHash
    });
});

test('bcrypt rejects passwords beyond 72 UTF-8 bytes instead of truncating', async (t) => {
    const fixture = await createFixture(t);
    const verifier = new BcryptPasswordVerifier();
    const exact = 'a'.repeat(72);
    const digest = await verifier.hash(exact);
    assert.equal(await verifier.verify(exact, digest), true);
    assert.equal(await verifier.verify(`${exact}b`, digest), false);
    await assert.rejects(verifier.hash('\u5236'.repeat(25)), /72 UTF-8 bytes/);

    const rejected = await fixture.app.request(jsonRequest('/api/platform/auth/register', {
        email: 'oversized@example.test',
        displayName: 'Oversized Producer',
        password: '\u5236'.repeat(25),
        code: '123456'
    }));
    assert.equal(rejected.status, 400);
    assert.deepEqual(await rejected.json(), {
        success: false,
        code: 'PLATFORM_AUTH_INPUT_INVALID'
    });
});

test('migrated PBKDF2 accepts only the declared Fudaba parameter contract', () => {
    const valid = {
        iterations: 100_000,
        hash: 'sha256',
        keyLength: 32,
        encoding: 'hex',
        saltEncoding: 'utf8'
    };
    assert.equal(isMigratedPbkdf2Parameters(JSON.stringify(valid)), true);
    for (const parameters of [
        { ...valid, iterations: 99_999 },
        { ...valid, hash: 'sha512' },
        { ...valid, keyLength: 64 },
        { ...valid, encoding: 'base64' },
        { ...valid, saltEncoding: 'hex' },
        { ...valid, extra: true },
        { iterations: 100_000, digest: 'sha256', keyLength: 32 }
    ]) {
        assert.equal(isMigratedPbkdf2Parameters(JSON.stringify(parameters)), false);
    }
    assert.equal(isMigratedPbkdf2Parameters('{'), false);
});

test('email auth strictly validates JSON shapes and credential fields', async (t) => {
    const { app } = await createFixture(t);
    const invalidRegistrations = [
        null,
        [],
        { email: 'invalid', displayName: 'Producer', password: PASSWORD, code: '123456' },
        {
            email: 'producer@example.test',
            displayName: '   ',
            password: PASSWORD,
            code: '123456'
        },
        {
            email: 'producer@example.test',
            displayName: 'Producer',
            password: 'short',
            code: '123456'
        },
        {
            email: 'producer@example.test',
            displayName: 'Producer',
            password: PASSWORD,
            code: '12345'
        },
        {
            email: 'producer@example.test',
            displayName: 'Producer',
            password: PASSWORD,
            code: '123456',
            role: 'admin'
        }
    ];
    for (const body of invalidRegistrations) {
        const response = await app.request(jsonRequest('/api/platform/auth/register', body));
        assert.equal(response.status, 400, JSON.stringify(body));
        assert.deepEqual(await response.json(), {
            success: false,
            code: 'PLATFORM_AUTH_INPUT_INVALID'
        });
        assertPrivateAuthResponse(response);
    }
    const invalidJson = await app.request('http://ims.test/api/platform/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{'
    });
    assert.equal(invalidJson.status, 400);
    assert.deepEqual(await invalidJson.json(), {
        success: false,
        code: 'PLATFORM_AUTH_INPUT_INVALID'
    });
    const missingJsonType = await app.request(
        'http://ims.test/api/platform/auth/register',
        { method: 'POST', body: JSON.stringify(invalidRegistrations[0]) }
    );
    assert.equal(missingJsonType.status, 415);
    assert.deepEqual(await missingJsonType.json(), {
        success: false,
        code: 'PLATFORM_AUTH_JSON_REQUIRED'
    });
});

test('Platform email auth routes use independent IP rate-limit buckets', async () => {
    const calls: Array<{ bucket: string; limit: number; windowSeconds: number }> = [];
    const app = createHonoApp(() => ({
        rateLimiter: {
            async consume(bucket, _key, limit, windowSeconds) {
                calls.push({ bucket, limit, windowSeconds });
                return {
                    allowed: bucket !== 'platform-auth-register',
                    remaining: limit - 1,
                    resetAt: Date.now() + 60_000
                };
            }
        }
    }));
    const login = await app.request(jsonRequest('/api/platform/auth/login', null));
    assert.equal(login.status, 400);
    const verification = await app.request(jsonRequest(
        '/api/platform/auth/register/verification-code',
        null
    ));
    assert.equal(verification.status, 400);
    const register = await app.request(jsonRequest('/api/platform/auth/register', null));
    assert.equal(register.status, 429);
    assertPrivateAuthResponse(register);
    assert.deepEqual(calls, [
        { bucket: 'global', limit: 10_000, windowSeconds: 15 * 60 },
        { bucket: 'platform-auth-login', limit: 20, windowSeconds: 15 * 60 },
        { bucket: 'global', limit: 10_000, windowSeconds: 15 * 60 },
        {
            bucket: 'platform-auth-email-verification',
            limit: 10,
            windowSeconds: 60 * 60
        },
        { bucket: 'global', limit: 10_000, windowSeconds: 15 * 60 },
        { bucket: 'platform-auth-register', limit: 10, windowSeconds: 60 * 60 }
    ]);
});

test('login account limiting shares a normalized digest across rotating IPs before lookup', async () => {
    const calls: Array<{
        bucket: string;
        key: string;
        limit: number;
        windowSeconds: number;
    }> = [];
    let repositoryLookups = 0;
    let passwordVerifications = 0;
    const resetAt = Date.now() + 61_000;
    const app = createHonoApp(() => ({
        platformAccounts: {
            async findEmailIdentity() {
                repositoryLookups += 1;
                return null;
            }
        },
        passwords: {
            async hash() {
                return 'unused';
            },
            async verify() {
                passwordVerifications += 1;
                return false;
            }
        },
        rateLimiter: {
            async consume(
                bucket: string,
                key: string,
                limit: number,
                windowSeconds: number
            ) {
                calls.push({ bucket, key, limit, windowSeconds });
                return {
                    allowed: bucket !== 'platform-auth-login-account',
                    remaining: limit - 1,
                    resetAt
                };
            }
        },
        config: { clientAddressSource: 'nginx' }
    } as unknown as RuntimeServices));
    const normalizedEmail = 'targeted.producer@example.test';
    const responses = [];
    for (const [email, ip] of [
        [' Targeted.Producer@Example.Test ', '198.51.100.20'],
        [normalizedEmail, '203.0.113.40']
    ]) {
        responses.push(await app.request(jsonRequest('/api/platform/auth/login', {
            email,
            password: PASSWORD
        }, {
            'X-Forwarded-For': ip
        })));
    }
    for (const response of responses) {
        assert.equal(response.status, 429);
        assert.deepEqual(await response.json(), { error: 'Too many requests' });
        assert.match(response.headers.get('retry-after') || '', /^(60|61)$/);
        assertPrivateAuthResponse(response);
    }
    assert.equal(repositoryLookups, 0);
    assert.equal(passwordVerifications, 0);
    assert.deepEqual(calls.map(({ bucket, limit, windowSeconds }) => ({
        bucket,
        limit,
        windowSeconds
    })), [
        { bucket: 'global', limit: 10_000, windowSeconds: 15 * 60 },
        { bucket: 'platform-auth-login', limit: 20, windowSeconds: 15 * 60 },
        { bucket: 'platform-auth-login-account', limit: 50, windowSeconds: 15 * 60 },
        { bucket: 'global', limit: 10_000, windowSeconds: 15 * 60 },
        { bucket: 'platform-auth-login', limit: 20, windowSeconds: 15 * 60 },
        { bucket: 'platform-auth-login-account', limit: 50, windowSeconds: 15 * 60 }
    ]);
    assert.equal(calls[0]?.key, '198.51.100.20');
    assert.equal(calls[1]?.key, '198.51.100.20');
    assert.equal(calls[3]?.key, '203.0.113.40');
    assert.equal(calls[4]?.key, '203.0.113.40');
    const expectedAccountKey = createHash('sha256')
        .update('imsweb:platform-auth:login-account:v1\0')
        .update(normalizedEmail)
        .digest('hex');
    assert.equal(calls[2]?.key, expectedAccountKey);
    assert.equal(calls[5]?.key, expectedAccountKey);
    assert.match(expectedAccountKey, /^[a-f0-9]{64}$/);
    assert.notEqual(expectedAccountKey, normalizedEmail);
    assert.doesNotMatch(JSON.stringify(calls), /Targeted\.Producer@Example\.Test/i);
});

test('real PostgreSQL keeps registration atomic under normalized email races', {
    skip: !postgresIntegrationEnabled() &&
        'set IMS_TEST_POSTGRES_ADMIN_URL to a local PostgreSQL admin database'
}, async (t) => {
    await assertRegistrationAndLogin(t, 'postgresql');

    const fixture = await createFixture(t, 'postgresql');
    assert.ok(fixture.databaseUrl);
    const secondConnection = PostgresConnection.create({
        connectionString: fixture.databaseUrl,
        maxConnections: 2,
        idleTimeoutMs: 5_000,
        connectionTimeoutMs: 5_000,
        statementTimeoutMs: 30_000,
        idleInTransactionTimeoutMs: 30_000
    });
    const secondRepository = new SqlPlatformAccountRepository(
        secondConnection,
        initializedPostgresSchema
    );
    await secondRepository.initialize();
    try {
        const [first, second] = await Promise.all([
            fixture.repository.createEmailAccount(emailAccount(
                'cross-instance@example.test',
                '$2b$12$bnPpILj3dtzbslu5F3vG4u7RzdkxYLF23bfHQBZv2bUfM4byX6NQ6'
            )),
            secondRepository.createEmailAccount(emailAccount(
                'cross-instance@example.test',
                '$2b$12$bnPpILj3dtzbslu5F3vG4u7RzdkxYLF23bfHQBZv2bUfM4byX6NQ6'
            ))
        ]);
        assert.deepEqual(
            [first.status, second.status].sort(),
            ['created', 'email-conflict']
        );
        assert.equal(await fixture.database.prepare(
            `SELECT COUNT(*) AS count FROM platform_email_credentials
             WHERE normalized_email=?`
        ).bind('cross-instance@example.test').first<number>('count'), 1);
    } finally {
        await secondRepository.close();
    }
});

test('real PostgreSQL failed resend preserves old code across repository instances', {
    skip: !postgresIntegrationEnabled() &&
        'set IMS_TEST_POSTGRES_ADMIN_URL to a local PostgreSQL admin database'
}, async (t) => {
    await assertFailedResendPreservesOldCode(t, 'postgresql');
});
