import type {
    CreatePlatformEmailAccountResult,
    CreateVerifiedPlatformEmailAccountResult,
    IssuePlatformEmailVerificationResult,
    NewPlatformRefreshSessionInput,
    NewPlatformAccountInput,
    NewPlatformEmailAccountInput,
    NewVerifiedPlatformEmailAccountInput,
    PlatformAccountRecord,
    PlatformAccountRepository,
    PlatformAccountWithProfile,
    PlatformEmailIdentity,
    PlatformEmailVerificationInput,
    PlatformProfileSaveResult,
    PlatformProfileRecord,
    PlatformRefreshSessionRecord,
    PlatformSecurityEventInput,
    UpdatePlatformProfileAvatarInput,
    UpdatePlatformProfileTextInput
} from '@/ports/repositories';
import type { ManagedSqlDatabase, SqlSchemaStrategy } from '@/infra/db/sql/database';
import { executeSql, queryOne, sqlStatement } from '@/infra/db/sql/query';

const ACCOUNT_COLUMNS = `id, status, token_version, created_at, updated_at,
    deleted_at`;
const PROFILE_COLUMNS = `account_id, display_name, avatar_object_key,
    avatar_external_url, home_city, bio, updated_at`;
const REFRESH_SESSION_COLUMNS = `id, account_id, token_hash, previous_token_hash,
    csrf_hash, expires_at, created_at, updated_at, revoked_at`;
const EMAIL_VERIFICATION_CLEANUP_LIMIT = 100;

interface PlatformAccountProfileRow extends PlatformAccountRecord {
    profile_account_id: string;
    profile_display_name: string;
    profile_avatar_object_key: string | null;
    profile_avatar_external_url: string | null;
    profile_home_city: string | null;
    profile_bio: string;
    profile_updated_at: number;
}

interface PlatformEmailIdentityRow extends PlatformAccountProfileRow {
    credential_normalized_email: string;
    credential_account_id: string;
    credential_algorithm: PlatformEmailIdentity['credential']['algorithm'];
    credential_parameters_json: string;
    credential_salt: string | null;
    credential_password_hash: string;
    credential_created_at: number;
    credential_updated_at: number;
}

function accountWithProfile(row: PlatformAccountProfileRow): PlatformAccountWithProfile {
    const account: PlatformAccountRecord = {
        id: row.id,
        status: row.status,
        token_version: row.token_version,
        created_at: row.created_at,
        updated_at: row.updated_at,
        deleted_at: row.deleted_at
    };
    const profile: PlatformProfileRecord = {
        account_id: row.profile_account_id,
        display_name: row.profile_display_name,
        avatar_object_key: row.profile_avatar_object_key,
        avatar_external_url: row.profile_avatar_external_url,
        home_city: row.profile_home_city,
        bio: row.profile_bio,
        updated_at: row.profile_updated_at
    };
    return { account, profile };
}

function emailIdentity(row: PlatformEmailIdentityRow): PlatformEmailIdentity {
    return {
        ...accountWithProfile(row),
        credential: {
            normalized_email: row.credential_normalized_email,
            account_id: row.credential_account_id,
            algorithm: row.credential_algorithm,
            parameters_json: row.credential_parameters_json,
            salt: row.credential_salt,
            password_hash: row.credential_password_hash,
            created_at: row.credential_created_at,
            updated_at: row.credential_updated_at
        }
    };
}

function isEmailConflict(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const candidate = error as { code?: unknown; constraint?: unknown; message?: unknown };
    if (
        candidate.code === '23505' &&
        candidate.constraint === 'platform_email_credentials_pkey'
    ) {
        return true;
    }
    return candidate.code === 'SQLITE_CONSTRAINT' &&
        typeof candidate.message === 'string' &&
        candidate.message.includes(
            'UNIQUE constraint failed: platform_email_credentials.normalized_email'
        );
}

function conditionalSecurityEventValues(event: PlatformSecurityEventInput): unknown[] {
    return [
        event.id,
        event.eventType,
        event.requestId,
        event.ipAddress,
        event.userAgent,
        event.metadataJson,
        event.createdAt
    ];
}

export class SqlPlatformAccountRepository implements PlatformAccountRepository {
    private initialized?: Promise<void>;
    private writeTail: Promise<void> = Promise.resolve();

    constructor(
        private readonly database: ManagedSqlDatabase,
        private readonly schema: SqlSchemaStrategy
    ) {}

    initialize(): Promise<void> {
        this.initialized ??= this.schema.initializePlatform(this.database);
        return this.initialized;
    }

    close(): Promise<void> {
        return this.database.close();
    }

    private serializeWrite<Value>(operation: () => Promise<Value>): Promise<Value> {
        const result = this.writeTail.then(operation, operation);
        this.writeTail = result.then(() => undefined, () => undefined);
        return result;
    }

    async createAccountWithProfile(
        input: NewPlatformAccountInput
    ): Promise<PlatformAccountWithProfile> {
        await this.serializeWrite(() => this.database.batch([
            sqlStatement(
                this.database,
                `INSERT INTO platform_accounts
                    (id, status, token_version, created_at, updated_at, deleted_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [
                    input.id,
                    input.status,
                    input.tokenVersion,
                    input.createdAt,
                    input.updatedAt,
                    input.deletedAt
                ]
            ),
            sqlStatement(
                this.database,
                `INSERT INTO platform_profiles
                    (account_id, display_name, avatar_object_key,
                     avatar_external_url, home_city, bio, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                    input.id,
                    input.profile.displayName,
                    input.profile.avatarObjectKey,
                    input.profile.avatarExternalUrl,
                    input.profile.homeCity,
                    input.profile.bio,
                    input.profile.updatedAt
                ]
            )
        ]));
        const created = await this.findAccountWithProfileById(input.id);
        if (!created) throw new Error('Platform account was not created');
        return created;
    }

    async createEmailAccount(
        input: NewPlatformEmailAccountInput
    ): Promise<CreatePlatformEmailAccountResult> {
        try {
            await this.serializeWrite(() => this.database.batch([
                sqlStatement(
                    this.database,
                    `INSERT INTO platform_accounts
                        (id, status, token_version, created_at, updated_at, deleted_at)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [
                        input.id,
                        input.status,
                        input.tokenVersion,
                        input.createdAt,
                        input.updatedAt,
                        input.deletedAt
                    ]
                ),
                sqlStatement(
                    this.database,
                    `INSERT INTO platform_profiles
                        (account_id, display_name, avatar_object_key,
                         avatar_external_url, home_city, bio, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [
                        input.id,
                        input.profile.displayName,
                        input.profile.avatarObjectKey,
                        input.profile.avatarExternalUrl,
                        input.profile.homeCity,
                        input.profile.bio,
                        input.profile.updatedAt
                    ]
                ),
                sqlStatement(
                    this.database,
                    `INSERT INTO platform_email_credentials
                        (normalized_email, account_id, algorithm, parameters_json,
                         salt, password_hash, created_at, updated_at)
                     VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
                    [
                        input.credential.normalizedEmail,
                        input.id,
                        input.credential.algorithm,
                        input.credential.parametersJson,
                        input.credential.passwordHash,
                        input.credential.createdAt,
                        input.credential.updatedAt
                    ]
                )
            ]));
        } catch (error) {
            if (isEmailConflict(error)) return { status: 'email-conflict' };
            throw error;
        }
        const identity = await this.findAccountWithProfileById(input.id);
        if (!identity) throw new Error('Platform email account was not created');
        return { status: 'created', identity };
    }

    issueEmailVerification(
        input: PlatformEmailVerificationInput
    ): Promise<IssuePlatformEmailVerificationResult> {
        return this.serializeWrite(async () => {
            const [, result] = await this.database.batch<{ resend_after: number }>([
                sqlStatement(
                    this.database,
                    `DELETE FROM platform_email_verification_codes
                     WHERE expires_at<=?
                       AND (pending_token IS NULL OR pending_expires_at<=?)
                       AND normalized_email IN (
                         SELECT normalized_email
                         FROM platform_email_verification_codes
                         WHERE expires_at<=?
                           AND (
                               pending_token IS NULL OR pending_expires_at<=?
                           )
                         ORDER BY expires_at, normalized_email
                         LIMIT ${EMAIL_VERIFICATION_CLEANUP_LIMIT}
                     )`,
                    [
                        input.createdAt,
                        input.createdAt,
                        input.createdAt,
                        input.createdAt
                    ]
                ),
                sqlStatement(
                    this.database,
                    `INSERT INTO platform_email_verification_codes
                        (normalized_email, code_hash, expires_at, resend_after,
                         attempts_remaining, consumed_token, created_at, updated_at,
                         delivery_token)
                     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)
                     ON CONFLICT(normalized_email) DO UPDATE SET
                        pending_token=excluded.delivery_token,
                        pending_code_hash=excluded.code_hash,
                        pending_expires_at=excluded.expires_at,
                        pending_resend_after=excluded.resend_after,
                        pending_attempts_remaining=excluded.attempts_remaining,
                        pending_created_at=excluded.created_at
                     WHERE platform_email_verification_codes.delivery_token IS NULL
                       AND platform_email_verification_codes.consumed_token IS NULL
                       AND platform_email_verification_codes.resend_after<=excluded.created_at
                       AND (
                           platform_email_verification_codes.pending_token IS NULL
                           OR platform_email_verification_codes.pending_expires_at<=
                                excluded.created_at
                       )
                     RETURNING resend_after`,
                    [
                        input.normalizedEmail,
                        input.codeHash,
                        input.expiresAt,
                        input.resendAfter,
                        input.attemptsRemaining,
                        input.createdAt,
                        input.createdAt,
                        input.deliveryToken
                    ]
                )
            ]);
            if (result?.results.length === 1) return { status: 'issued' };
            const current = await queryOne<{
                retry_after: number;
            }>(
                this.database,
                `SELECT CASE
                            WHEN delivery_token IS NOT NULL THEN expires_at
                            WHEN pending_token IS NOT NULL AND pending_expires_at>?
                                THEN pending_expires_at
                            ELSE resend_after
                        END AS retry_after
                 FROM platform_email_verification_codes
                 WHERE normalized_email=?`,
                [input.createdAt, input.normalizedEmail]
            );
            return {
                status: 'cooldown',
                retryAfterMs: Math.max(
                    1,
                    Number(current?.retry_after ?? input.resendAfter) - input.createdAt
                )
            };
        });
    }

    async completeEmailVerificationDelivery(
        normalizedEmail: string,
        deliveryToken: string
    ): Promise<boolean> {
        return this.serializeWrite(async () => {
            const result = await executeSql(
                this.database,
                `UPDATE platform_email_verification_codes
                 SET code_hash=CASE
                         WHEN pending_token=? THEN pending_code_hash
                         ELSE code_hash
                     END,
                     expires_at=CASE
                         WHEN pending_token=? THEN pending_expires_at
                         ELSE expires_at
                     END,
                     resend_after=CASE
                         WHEN pending_token=? THEN pending_resend_after
                         ELSE resend_after
                     END,
                     attempts_remaining=CASE
                         WHEN pending_token=? THEN pending_attempts_remaining
                         ELSE attempts_remaining
                     END,
                     consumed_token=NULL,
                     created_at=CASE
                         WHEN pending_token=? THEN pending_created_at
                         ELSE created_at
                     END,
                     updated_at=CASE
                         WHEN pending_token=? THEN pending_created_at
                         ELSE updated_at
                     END,
                     delivery_token=NULL,
                     pending_token=NULL,
                     pending_code_hash=NULL,
                     pending_expires_at=NULL,
                     pending_resend_after=NULL,
                     pending_attempts_remaining=NULL,
                     pending_created_at=NULL
                 WHERE normalized_email=? AND consumed_token IS NULL
                   AND (delivery_token=? OR pending_token=?)`,
                [
                    deliveryToken,
                    deliveryToken,
                    deliveryToken,
                    deliveryToken,
                    deliveryToken,
                    deliveryToken,
                    normalizedEmail,
                    deliveryToken,
                    deliveryToken
                ]
            );
            return result.meta.changes === 1;
        });
    }

    async revokeEmailVerification(
        normalizedEmail: string,
        deliveryToken: string
    ): Promise<void> {
        await this.serializeWrite(async () => {
            await this.database.batch([
                sqlStatement(
                    this.database,
                    `UPDATE platform_email_verification_codes
                     SET pending_token=NULL,
                         pending_code_hash=NULL,
                         pending_expires_at=NULL,
                         pending_resend_after=NULL,
                         pending_attempts_remaining=NULL,
                         pending_created_at=NULL
                     WHERE normalized_email=? AND pending_token=?`,
                    [normalizedEmail, deliveryToken]
                ),
                sqlStatement(
                    this.database,
                    `DELETE FROM platform_email_verification_codes
                     WHERE normalized_email=? AND delivery_token=?
                       AND pending_token IS NULL AND consumed_token IS NULL`,
                    [normalizedEmail, deliveryToken]
                )
            ]);
        });
    }

    createVerifiedEmailAccount(
        input: NewVerifiedPlatformEmailAccountInput
    ): Promise<CreateVerifiedPlatformEmailAccountResult> {
        return this.serializeWrite(async () => {
            let results;
            try {
                results = await this.database.batch([
                    sqlStatement(
                        this.database,
                        `UPDATE platform_email_verification_codes
                         SET attempts_remaining=attempts_remaining-
                                CASE WHEN code_hash=? THEN 0 ELSE 1 END,
                             consumed_token=CASE WHEN code_hash=? THEN ? ELSE NULL END,
                             updated_at=?
                         WHERE normalized_email=? AND consumed_token IS NULL
                           AND delivery_token IS NULL
                           AND expires_at>? AND attempts_remaining>0
                         RETURNING consumed_token`,
                        [
                            input.verification.codeHash,
                            input.verification.codeHash,
                            input.verification.consumedToken,
                            input.verification.verifiedAt,
                            input.credential.normalizedEmail,
                            input.verification.verifiedAt
                        ]
                    ),
                    sqlStatement(
                        this.database,
                        `INSERT INTO platform_accounts
                            (id, status, token_version, created_at, updated_at, deleted_at)
                         SELECT ?, ?, ?, ?, ?, ?
                         WHERE EXISTS (
                             SELECT 1 FROM platform_email_verification_codes
                             WHERE normalized_email=? AND code_hash=?
                               AND consumed_token=? AND expires_at>?
                         )`,
                        [
                            input.id,
                            input.status,
                            input.tokenVersion,
                            input.createdAt,
                            input.updatedAt,
                            input.deletedAt,
                            input.credential.normalizedEmail,
                            input.verification.codeHash,
                            input.verification.consumedToken,
                            input.verification.verifiedAt
                        ]
                    ),
                    sqlStatement(
                        this.database,
                        `INSERT INTO platform_profiles
                            (account_id, display_name, avatar_object_key,
                             avatar_external_url, home_city, bio, updated_at)
                         SELECT ?, ?, ?, ?, ?, ?, ?
                         WHERE EXISTS (
                             SELECT 1 FROM platform_accounts account
                             JOIN platform_email_verification_codes verification
                               ON verification.normalized_email=?
                             WHERE account.id=? AND verification.code_hash=?
                               AND verification.consumed_token=?
                               AND verification.expires_at>?
                         )`,
                        [
                            input.id,
                            input.profile.displayName,
                            input.profile.avatarObjectKey,
                            input.profile.avatarExternalUrl,
                            input.profile.homeCity,
                            input.profile.bio,
                            input.profile.updatedAt,
                            input.credential.normalizedEmail,
                            input.id,
                            input.verification.codeHash,
                            input.verification.consumedToken,
                            input.verification.verifiedAt
                        ]
                    ),
                    sqlStatement(
                        this.database,
                        `INSERT INTO platform_email_credentials
                            (normalized_email, account_id, algorithm, parameters_json,
                             salt, password_hash, created_at, updated_at)
                         SELECT ?, ?, ?, ?, NULL, ?, ?, ?
                         WHERE EXISTS (
                             SELECT 1 FROM platform_accounts account
                             JOIN platform_profiles profile ON profile.account_id=account.id
                             JOIN platform_email_verification_codes verification
                               ON verification.normalized_email=?
                             WHERE account.id=? AND verification.code_hash=?
                               AND verification.consumed_token=?
                               AND verification.expires_at>?
                         )`,
                        [
                            input.credential.normalizedEmail,
                            input.id,
                            input.credential.algorithm,
                            input.credential.parametersJson,
                            input.credential.passwordHash,
                            input.credential.createdAt,
                            input.credential.updatedAt,
                            input.credential.normalizedEmail,
                            input.id,
                            input.verification.codeHash,
                            input.verification.consumedToken,
                            input.verification.verifiedAt
                        ]
                    ),
                    sqlStatement(
                        this.database,
                        `DELETE FROM platform_email_verification_codes
                         WHERE normalized_email=? AND code_hash=? AND consumed_token=?
                           AND EXISTS (
                               SELECT 1 FROM platform_email_credentials credential
                               WHERE credential.normalized_email=? AND credential.account_id=?
                           )`,
                        [
                            input.credential.normalizedEmail,
                            input.verification.codeHash,
                            input.verification.consumedToken,
                            input.credential.normalizedEmail,
                            input.id
                        ]
                    )
                ]);
            } catch (error) {
                if (isEmailConflict(error)) return { status: 'email-conflict' };
                throw error;
            }
            if (results[3]?.meta.changes !== 1 || results[4]?.meta.changes !== 1) {
                return { status: 'verification-invalid' };
            }
            const identity = await this.findAccountWithProfileById(input.id);
            if (!identity) throw new Error('Verified Platform email account was not created');
            return { status: 'created', identity };
        });
    }

    findAccountById(id: string): Promise<PlatformAccountRecord | null> {
        return queryOne<PlatformAccountRecord>(
            this.database,
            `SELECT ${ACCOUNT_COLUMNS} FROM platform_accounts WHERE id=?`,
            [id]
        );
    }

    async findAccountWithProfileById(
        id: string
    ): Promise<PlatformAccountWithProfile | null> {
        const row = await queryOne<PlatformAccountProfileRow>(
            this.database,
            `SELECT accounts.id, accounts.status, accounts.token_version,
                    accounts.created_at, accounts.updated_at, accounts.deleted_at,
                    profiles.account_id AS profile_account_id,
                    profiles.display_name AS profile_display_name,
                    profiles.avatar_object_key AS profile_avatar_object_key,
                    profiles.avatar_external_url AS profile_avatar_external_url,
                    profiles.home_city AS profile_home_city,
                    profiles.bio AS profile_bio,
                    profiles.updated_at AS profile_updated_at
             FROM platform_accounts accounts
             JOIN platform_profiles profiles ON profiles.account_id=accounts.id
             WHERE accounts.id=?`,
            [id]
        );
        return row ? accountWithProfile(row) : null;
    }

    async findEmailIdentity(normalizedEmail: string): Promise<PlatformEmailIdentity | null> {
        const row = await queryOne<PlatformEmailIdentityRow>(
            this.database,
            `SELECT accounts.id, accounts.status, accounts.token_version,
                    accounts.created_at, accounts.updated_at, accounts.deleted_at,
                    profiles.account_id AS profile_account_id,
                    profiles.display_name AS profile_display_name,
                    profiles.avatar_object_key AS profile_avatar_object_key,
                    profiles.avatar_external_url AS profile_avatar_external_url,
                    profiles.home_city AS profile_home_city,
                    profiles.bio AS profile_bio,
                    profiles.updated_at AS profile_updated_at,
                    credentials.normalized_email AS credential_normalized_email,
                    credentials.account_id AS credential_account_id,
                    credentials.algorithm AS credential_algorithm,
                    credentials.parameters_json AS credential_parameters_json,
                    credentials.salt AS credential_salt,
                    credentials.password_hash AS credential_password_hash,
                    credentials.created_at AS credential_created_at,
                    credentials.updated_at AS credential_updated_at
             FROM platform_email_credentials credentials
             JOIN platform_accounts accounts ON accounts.id=credentials.account_id
             JOIN platform_profiles profiles ON profiles.account_id=accounts.id
             WHERE credentials.normalized_email=?`,
            [normalizedEmail]
        );
        return row ? emailIdentity(row) : null;
    }

    async upgradeEmailCredentialToBcrypt(input: {
        normalizedEmail: string;
        expectedAlgorithm: 'pbkdf2-sha256';
        expectedPasswordHash: string;
        expectedUpdatedAt: number;
        passwordHash: string;
        parametersJson: string;
        updatedAt: number;
    }): Promise<boolean> {
        return this.serializeWrite(async () => {
            const result = await executeSql(
                this.database,
                `UPDATE platform_email_credentials
                 SET algorithm='bcrypt', parameters_json=?, salt=NULL,
                     password_hash=?, updated_at=?
                 WHERE normalized_email=? AND algorithm=? AND password_hash=?
                   AND updated_at=?`,
                [
                    input.parametersJson,
                    input.passwordHash,
                    input.updatedAt,
                    input.normalizedEmail,
                    input.expectedAlgorithm,
                    input.expectedPasswordHash,
                    input.expectedUpdatedAt
                ]
            );
            return result.meta.changes === 1;
        });
    }

    private findActiveProfileById(
        accountId: string
    ): Promise<PlatformProfileRecord | null> {
        return queryOne<PlatformProfileRecord>(
            this.database,
            `SELECT ${PROFILE_COLUMNS}
             FROM platform_profiles
             WHERE account_id=? AND EXISTS (
                 SELECT 1 FROM platform_accounts account
                 WHERE account.id=platform_profiles.account_id
                   AND account.status='active' AND account.deleted_at IS NULL
             )`,
            [accountId]
        );
    }

    private profileWriteFailure(
        current: PlatformProfileRecord | null,
        expectedUpdatedAt: number
    ): PlatformProfileSaveResult {
        if (!current) return { status: 'unavailable' };
        if (current.updated_at !== expectedUpdatedAt) {
            return { status: 'conflict', updatedAt: current.updated_at };
        }
        return { status: 'unavailable' };
    }

    updateProfileTextForOwner(
        input: UpdatePlatformProfileTextInput
    ): Promise<PlatformProfileSaveResult> {
        return this.serializeWrite(async () => {
            const current = await this.findActiveProfileById(input.accountId);
            if (!current || current.updated_at !== input.expectedUpdatedAt) {
                return this.profileWriteFailure(current, input.expectedUpdatedAt);
            }
            const result = await this.database.prepare(
                `UPDATE platform_profiles
                 SET display_name=?, home_city=?, bio=?, updated_at=?
                 WHERE account_id=? AND updated_at=? AND EXISTS (
                     SELECT 1 FROM platform_accounts account
                     WHERE account.id=platform_profiles.account_id
                       AND account.status='active' AND account.deleted_at IS NULL
                 )
                 RETURNING ${PROFILE_COLUMNS}`
            ).bind(
                input.displayName,
                input.homeCity,
                input.bio,
                input.updatedAt,
                input.accountId,
                input.expectedUpdatedAt
            ).run<PlatformProfileRecord>();
            const saved = result.results[0];
            if (saved) {
                return {
                    status: 'saved',
                    profile: saved,
                    previousAvatarObjectKey: current.avatar_object_key
                };
            }
            return this.profileWriteFailure(
                await this.findActiveProfileById(input.accountId),
                input.expectedUpdatedAt
            );
        });
    }

    updateProfileAvatarForOwner(
        input: UpdatePlatformProfileAvatarInput
    ): Promise<PlatformProfileSaveResult> {
        return this.serializeWrite(async () => {
            const current = await this.findActiveProfileById(input.accountId);
            if (!current || current.updated_at !== input.expectedUpdatedAt) {
                return this.profileWriteFailure(current, input.expectedUpdatedAt);
            }
            const result = await this.database.prepare(
                `UPDATE platform_profiles
                 SET avatar_object_key=?, avatar_external_url=NULL, updated_at=?
                 WHERE account_id=? AND updated_at=? AND EXISTS (
                     SELECT 1 FROM platform_accounts account
                     WHERE account.id=platform_profiles.account_id
                       AND account.status='active' AND account.deleted_at IS NULL
                 )
                 RETURNING ${PROFILE_COLUMNS}`
            ).bind(
                input.avatarObjectKey,
                input.updatedAt,
                input.accountId,
                input.expectedUpdatedAt
            ).run<PlatformProfileRecord>();
            const saved = result.results[0];
            if (saved) {
                return {
                    status: 'saved',
                    profile: saved,
                    previousAvatarObjectKey: current.avatar_object_key
                };
            }
            return this.profileWriteFailure(
                await this.findActiveProfileById(input.accountId),
                input.expectedUpdatedAt
            );
        });
    }

    async createRefreshSession(input: NewPlatformRefreshSessionInput): Promise<boolean> {
        const results = await this.serializeWrite(() => this.database.batch([
            sqlStatement(
                this.database,
                `INSERT INTO platform_refresh_sessions
                    (id, account_id, token_hash, previous_token_hash, csrf_hash,
                     expires_at, created_at, updated_at, revoked_at)
                 SELECT ?, account.id, ?, NULL, ?, ?, ?, ?, NULL
                 FROM platform_accounts account
                 WHERE account.id=? AND account.token_version=?
                   AND account.status IN ('active', 'restricted')
                   AND account.deleted_at IS NULL`,
                [
                    input.id,
                    input.tokenHash,
                    input.csrfHash,
                    input.expiresAt,
                    input.createdAt,
                    input.createdAt,
                    input.accountId,
                    input.accountTokenVersion
                ]
            ),
            sqlStatement(
                this.database,
                `INSERT INTO platform_security_events
                    (id, account_id, event_type, request_id, ip_address, user_agent,
                     metadata_json, created_at)
                 SELECT ?, account_id, ?, ?, ?, ?, ?, ?
                 FROM platform_refresh_sessions
                 WHERE id=? AND account_id=? AND token_hash=?`,
                [
                    ...conditionalSecurityEventValues(input.event),
                    input.id,
                    input.accountId,
                    input.tokenHash
                ]
            )
        ]));
        return results[0]?.meta.changes === 1;
    }

    findRefreshSessionById(id: string): Promise<PlatformRefreshSessionRecord | null> {
        return queryOne<PlatformRefreshSessionRecord>(
            this.database,
            `SELECT ${REFRESH_SESSION_COLUMNS}
             FROM platform_refresh_sessions WHERE id=?`,
            [id]
        );
    }

    findRefreshSessionByTokenHash(
        tokenHash: string
    ): Promise<PlatformRefreshSessionRecord | null> {
        return queryOne<PlatformRefreshSessionRecord>(
            this.database,
            `SELECT ${REFRESH_SESSION_COLUMNS}
             FROM platform_refresh_sessions
             WHERE token_hash=? OR previous_token_hash=?
             ORDER BY CASE WHEN token_hash=? THEN 0 ELSE 1 END
             LIMIT 1`,
            [tokenHash, tokenHash, tokenHash]
        );
    }

    async rotateRefreshSession(input: {
        id: string;
        accountTokenVersion: number;
        currentTokenHash: string;
        nextTokenHash: string;
        nextCsrfHash: string;
        nextExpiresAt: number;
        updatedAt: number;
        event: PlatformSecurityEventInput;
    }): Promise<boolean> {
        const results = await this.serializeWrite(() => this.database.batch([
            sqlStatement(
                this.database,
                `UPDATE platform_refresh_sessions
                 SET previous_token_hash=token_hash, token_hash=?, csrf_hash=?,
                     expires_at=?, updated_at=?
                 WHERE id=? AND token_hash=? AND revoked_at IS NULL AND expires_at>?
                   AND EXISTS (
                       SELECT 1 FROM platform_accounts account
                       WHERE account.id=platform_refresh_sessions.account_id
                         AND account.token_version=?
                         AND account.status IN ('active', 'restricted')
                         AND account.deleted_at IS NULL
                   )`,
                [
                    input.nextTokenHash,
                    input.nextCsrfHash,
                    input.nextExpiresAt,
                    input.updatedAt,
                    input.id,
                    input.currentTokenHash,
                    input.updatedAt,
                    input.accountTokenVersion
                ]
            ),
            sqlStatement(
                this.database,
                `INSERT INTO platform_security_events
                    (id, account_id, event_type, request_id, ip_address, user_agent,
                     metadata_json, created_at)
                 SELECT ?, account_id, ?, ?, ?, ?, ?, ?
                 FROM platform_refresh_sessions
                 WHERE id=? AND account_id=? AND token_hash=?
                   AND previous_token_hash=? AND csrf_hash=? AND expires_at=?
                   AND updated_at=? AND revoked_at IS NULL`,
                [
                    ...conditionalSecurityEventValues(input.event),
                    input.id,
                    input.event.accountId,
                    input.nextTokenHash,
                    input.currentTokenHash,
                    input.nextCsrfHash,
                    input.nextExpiresAt,
                    input.updatedAt
                ]
            )
        ]));
        return results[0]?.meta.changes === 1;
    }

    async revokeRefreshSession(input: {
        id: string;
        accountId: string;
        revokedAt: number;
        event: PlatformSecurityEventInput;
    }): Promise<boolean> {
        const results = await this.serializeWrite(() => this.database.batch([
            sqlStatement(
                this.database,
                `INSERT INTO platform_security_events
                    (id, account_id, event_type, request_id, ip_address, user_agent,
                     metadata_json, created_at)
                 SELECT ?, account_id, ?, ?, ?, ?, ?, ?
                 FROM platform_refresh_sessions
                 WHERE id=? AND account_id=? AND revoked_at IS NULL`,
                [
                    ...conditionalSecurityEventValues(input.event),
                    input.id,
                    input.accountId
                ]
            ),
            sqlStatement(
                this.database,
                `UPDATE platform_refresh_sessions
                 SET revoked_at=?, updated_at=?
                 WHERE id=? AND account_id=? AND revoked_at IS NULL`,
                [input.revokedAt, input.revokedAt, input.id, input.accountId]
            )
        ]));
        return results[1]?.meta.changes === 1;
    }

    async revokeRefreshSessionForReplay(input: {
        id: string;
        accountId: string;
        replayedTokenHash: string;
        revokedAt: number;
        event: PlatformSecurityEventInput;
    }): Promise<boolean> {
        const results = await this.serializeWrite(() => this.database.batch([
            sqlStatement(
                this.database,
                `INSERT INTO platform_security_events
                    (id, account_id, event_type, request_id, ip_address, user_agent,
                     metadata_json, created_at)
                 SELECT ?, account_id, ?, ?, ?, ?, ?, ?
                 FROM platform_refresh_sessions
                 WHERE id=? AND account_id=? AND previous_token_hash=?
                   AND revoked_at IS NULL`,
                [
                    ...conditionalSecurityEventValues(input.event),
                    input.id,
                    input.accountId,
                    input.replayedTokenHash
                ]
            ),
            sqlStatement(
                this.database,
                `UPDATE platform_refresh_sessions
                 SET revoked_at=?, updated_at=?
                 WHERE id=? AND account_id=? AND previous_token_hash=?
                   AND revoked_at IS NULL`,
                [
                    input.revokedAt,
                    input.revokedAt,
                    input.id,
                    input.accountId,
                    input.replayedTokenHash
                ]
            )
        ]));
        return results[1]?.meta.changes === 1;
    }

    async deleteExpiredRefreshSessions(now: number): Promise<void> {
        await this.serializeWrite(async () => {
            await executeSql(
                this.database,
                'DELETE FROM platform_refresh_sessions WHERE expires_at<=?',
                [now]
            );
        });
    }
}
