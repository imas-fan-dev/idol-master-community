import '@/runtime/node-environment';
import { S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { NodeDatabaseConfig } from '@/config/database';
import type { NodeObjectStorageConfig } from '@/config/object-storage';
import type {
    AdminAccountRepository,
    AuditRepository,
    BackofficeAuthRepository,
    EventRepository,
    FudabaRepository,
    HomepageLinkRepository,
    NamecardRepository,
    NewsRepository,
    PlatformAccountRepository,
    ReactionRepository,
    SitePackageRepository,
    StoryRepository
} from '@/ports/repositories';
import type { ManagedSqlDatabase, SqlSchemaStrategy } from '@/infra/db/sql/database';
import type { ObjectStorageServices } from '@/ports/object-storage';
import type { NodeRuntimeServices, RuntimeServices } from '@/ports/runtime-services';
import {
    COMPENSATION_DIR,
    EVENT_BASE,
    IDEMPOTENCY_DIR,
    PUBLIC_DIR,
    STORY_DATA_DIR,
    UPLOADS_DIR,
    ensureRuntimeDirectories
} from '@/config/paths';
import {
    BACKOFFICE_JWT_SECRET,
    CLIENT_ADDRESS_SOURCE,
    COOKIE_OPTIONS,
    FUDABA_MAP_ENABLED,
    FUDABA_MAP_STYLE_URL,
    FUDABA_PUBLIC_READ_ENABLED,
    FUDABA_WRITE_ENABLED,
    IS_PRODUCTION,
    LEGACY_BACKOFFICE_JWT_SECRET,
    PLATFORM_JWT_SECRET,
    SITE_PACKAGE_MAX_UPLOAD_BYTES,
    STORY_MAX_UPLOAD_BYTES,
    SUPER_ADMIN_USERNAME
} from '@/config/env';
import { parseNodeObjectStorageConfig } from '@/config/object-storage';
import { parseNodeDatabaseConfig } from '@/config/database';
import { parsePlatformEmailConfig } from '@/config/platform-email';
import { FilesystemIdempotencyStore } from '@/infra/cache/filesystem/idempotency-store';
import { MemoryRateLimiter } from '@/infra/cache/memory/rate-limiter';
import { SqlFudabaRateLimiter } from '@/infra/cache/sql/fudaba-rate-limiter';
import { PostgresConnection } from '@/infra/db/postgresql/connection';
import { PostgresqlSchemaStrategy } from '@/infra/db/postgresql/schema-strategy';
import { SqlCoreRepository } from '@/infra/db/repositories/core-repository';
import { SqlFudabaRepository } from '@/infra/db/repositories/fudaba-repository';
import { SqlPlatformAccountRepository } from '@/infra/db/repositories/platform-account-repository';
import { SqlStoryRepository } from '@/infra/db/repositories/story-repository';
import { StreamingUploadParser } from '@/infra/http/busboy/upload-parser';
import { FilesystemCompensationService } from '@/infra/oss/filesystem/compensation-service';
import {
    FilesystemObjectStorage,
    type FilesystemStorageRoots
} from '@/infra/oss/filesystem/object-storage';
import {
    FrontendStaticAssets,
    listFrontendFiles,
    NodeStaticAssets
} from '@/infra/http/filesystem/static-assets';
import { S3CompensationService } from '@/infra/oss/s3/compensation-service';
import { S3ObjectStorage } from '@/infra/oss/s3/object-storage';
import { S3UploadStateMachine } from '@/infra/oss/s3/upload-state-machine';
import { SharpImageProcessor } from '@/infra/media/sharp/image-processor';
import { BcryptPasswordVerifier } from '@/infra/security/bcrypt/password-verifier';
import { createPlatformEmailSender } from '@/infra/email/cloudflare/platform-email-sender';
import { HmacBackofficeTokenService } from '@/infra/security/hmac/token-service';
import { HmacPlatformTokenService } from '@/infra/security/hmac/platform-token-service';

interface InitializableResource {
    initialize(): Promise<void>;
    close(): Promise<void>;
}

interface CoreRepositoryAdapter extends
    InitializableResource,
    BackofficeAuthRepository,
    AdminAccountRepository,
    AuditRepository,
    NewsRepository,
    EventRepository,
    NamecardRepository,
    ReactionRepository,
    HomepageLinkRepository,
    SitePackageRepository {}

interface StoryRepositoryAdapter extends InitializableResource, StoryRepository {}

interface PlatformAccountRepositoryAdapter extends
    InitializableResource,
    PlatformAccountRepository {}

interface FudabaRepositoryAdapter extends InitializableResource, FudabaRepository {}

interface NodeRepositories {
    database: ManagedSqlDatabase;
    core: CoreRepositoryAdapter;
    platform: PlatformAccountRepositoryAdapter;
    fudaba: FudabaRepositoryAdapter;
    story: StoryRepositoryAdapter;
}

export function validateFudabaPublicReadStorage(
    enabled: boolean,
    config: NodeObjectStorageConfig
): void {
    if (!enabled) return;
    if (config.type !== 's3') {
        throw new Error(
            'IMS_OBJECT_STORAGE=s3 is required when ' +
            'IMS_FUDABA_PUBLIC_READ_ENABLED=true'
        );
    }
    if (!config.publicReadUrlBase) {
        throw new Error(
            'IMS_PUBLIC_READ_URL_BASE is required when ' +
            'IMS_FUDABA_PUBLIC_READ_ENABLED=true'
        );
    }
}

function createNodeRepositories(config: NodeDatabaseConfig): NodeRepositories {
    const database = PostgresConnection.create(config);
    const schema = new PostgresqlSchemaStrategy();
    return {
        database,
        core: new SqlCoreRepository(database, schema),
        platform: new SqlPlatformAccountRepository(database, schema),
        fudaba: new SqlFudabaRepository(database, schema),
        story: new SqlStoryRepository(database, schema)
    };
}

async function createNodeObjectStorage(
    config: NodeObjectStorageConfig,
    filesystemRoots: FilesystemStorageRoots,
    database: ManagedSqlDatabase
): Promise<ObjectStorageServices> {
    if (config.type === 'filesystem') {
        return {
            compensation: new FilesystemCompensationService(COMPENSATION_DIR),
            storage: new FilesystemObjectStorage(filesystemRoots, {
                publicReadUrlBase: config.publicReadUrlBase
            })
        };
    }
    const client = new S3Client({
        region: config.region,
        endpoint: config.endpoint,
        forcePathStyle: config.forcePathStyle
    });
    const options = {
        bucket: config.bucket,
        publicReadUrlBase: config.publicReadUrlBase,
        prefix: config.prefix,
        readUrlTtlSeconds: config.readUrlTtlSeconds
    };
    const state = new S3UploadStateMachine(database);
    try {
        await state.initialize();
    } catch (error) {
        client.destroy();
        throw error;
    }
    let storage: S3ObjectStorage;
    const compensation = new S3CompensationService(
        database,
        state,
        (objectId, physicalKey, storageScope) =>
            storage.deletePhysicalObject(objectId, physicalKey, storageScope)
    );
    storage = new S3ObjectStorage(
        client,
        options,
        (command, expiresIn) => getSignedUrl(client, command, { expiresIn }),
        state,
        compensation
    );
    return { compensation, storage };
}

export async function initializeNodeRepositories(
    ...repositories: InitializableResource[]
): Promise<void> {
    try {
        for (const repository of repositories) await repository.initialize();
    } catch (error) {
        await Promise.allSettled(
            [...repositories].reverse().map((repository) => repository.close())
        );
        throw error;
    }
}

async function closeRuntimeServices(services: RuntimeServices): Promise<void> {
    const backofficeAuth = services.backofficeAuth as (
        BackofficeAuthRepository & Partial<InitializableResource>
    ) | undefined;
    const story = services.story as (StoryRepository & Partial<InitializableResource>) | undefined;
    const platform = services.platformAccounts as (
        PlatformAccountRepository & Partial<InitializableResource>
    ) | undefined;
    const fudaba = services.fudaba as (
        FudabaRepository & Partial<InitializableResource>
    ) | undefined;
    const results = await Promise.allSettled([
        services.storage?.close
            ? Promise.resolve().then(() => services.storage?.close?.())
            : undefined,
        story?.close?.(),
        fudaba?.close?.(),
        platform?.close?.(),
        backofficeAuth?.close?.()
    ].filter((operation): operation is Promise<void> => Boolean(operation)));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), 'Failed to close Node services');
}

export function createNodeServiceLifecycle<Services extends RuntimeServices>(
    factory: () => Promise<Services>
): {
    resolve(): Promise<Services>;
    close(): Promise<void>;
} {
    let current: Promise<Services> | undefined;
    let closing: Promise<void> | undefined;
    return {
        resolve(): Promise<Services> {
            if (!current) {
                const created = factory();
                current = created;
                void created.catch(() => {
                    if (current === created) current = undefined;
                });
            }
            return current;
        },
        close(): Promise<void> {
            if (!current) return Promise.resolve();
            if (closing) return closing;
            const target = current;
            closing = (async () => {
                const services = await target.catch(() => undefined);
                if (services) await closeRuntimeServices(services);
            })().finally(() => {
                if (current === target) current = undefined;
                closing = undefined;
            });
            return closing;
        }
    };
}

export async function createNodeServices(): Promise<NodeRuntimeServices> {
    const objectStorage = parseNodeObjectStorageConfig();
    validateFudabaPublicReadStorage(FUDABA_PUBLIC_READ_ENABLED, objectStorage);
    const database = parseNodeDatabaseConfig(process.env);
    const platformEmailSender = createPlatformEmailSender(
        parsePlatformEmailConfig(),
        globalThis.fetch
    );
    ensureRuntimeDirectories(objectStorage.type === 'filesystem');
    const { database: connection, core, platform, fudaba, story } = createNodeRepositories(database);
    try {
        await initializeNodeRepositories(core, platform, fudaba, story);
        if (IS_PRODUCTION || SUPER_ADMIN_USERNAME) {
            await core.ensureSuperAdmin(SUPER_ADMIN_USERNAME);
        }
        const filesystemRoots = {
            publicDir: PUBLIC_DIR,
            uploadsDir: UPLOADS_DIR,
            chronicleDir: EVENT_BASE,
            storyDataDir: STORY_DATA_DIR
        };
        const objectStorageInfrastructure = await createNodeObjectStorage(
            objectStorage,
            filesystemRoots,
            connection
        );
        return {
            backofficeAuth: core,
            adminAccounts: core,
            platformAccounts: platform,
            fudaba,
            audit: core,
            news: core,
            events: core,
            namecards: core,
            reactions: core,
            homepageLinks: core,
            sitePackages: core,
            story,
            ...objectStorageInfrastructure,
            images: new SharpImageProcessor(),
            staticAssets: new FrontendStaticAssets(
                new NodeStaticAssets(PUBLIC_DIR),
                new Set(listFrontendFiles(PUBLIC_DIR))
            ),
            uploads: new StreamingUploadParser(),
            idempotency: new FilesystemIdempotencyStore(IDEMPOTENCY_DIR),
            rateLimiter: new SqlFudabaRateLimiter(connection, new MemoryRateLimiter()),
            health: {
                async check() {
                    await connection.prepare('SELECT 1 AS ready').first('ready');
                }
            },
            passwords: new BcryptPasswordVerifier(),
            platformEmailSender,
            backofficeTokens: new HmacBackofficeTokenService(
                BACKOFFICE_JWT_SECRET,
                LEGACY_BACKOFFICE_JWT_SECRET
            ),
            platformTokens: new HmacPlatformTokenService(PLATFORM_JWT_SECRET),
            fetch: globalThis.fetch,
            config: {
                cookieSecure: COOKIE_OPTIONS.secure,
                storyMaxUploadBytes: STORY_MAX_UPLOAD_BYTES,
                sitePackageMaxUploadBytes: SITE_PACKAGE_MAX_UPLOAD_BYTES,
                clientAddressSource: CLIENT_ADDRESS_SOURCE,
                fudabaPublicReadEnabled: FUDABA_PUBLIC_READ_ENABLED,
                fudabaWriteEnabled: FUDABA_WRITE_ENABLED,
                fudabaMapEnabled: FUDABA_MAP_ENABLED,
                fudabaMapStyleUrl: FUDABA_MAP_STYLE_URL
            }
        };
    } catch (error) {
        await Promise.allSettled([
            story.close(),
            fudaba.close(),
            platform.close(),
            core.close()
        ]);
        throw error;
    }
}

const lifecycle = createNodeServiceLifecycle(createNodeServices);

export function resolveNodeServices(): Promise<NodeRuntimeServices> {
    return lifecycle.resolve();
}

export async function closeNodeServices(): Promise<void> {
    await lifecycle.close();
}
