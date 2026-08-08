import type { CacheServices } from '@/ports/cache';
import type { EmailServices } from '@/ports/email';
import type { HttpServices } from '@/ports/http';
import type { MediaServices } from '@/ports/media';
import type { ObjectStorageServices } from '@/ports/object-storage';
import type { RepositoryServices } from '@/ports/repositories';
import type { SecurityServices } from '@/ports/security';

export interface NodeRuntimeConfig {
    cookieSecure: boolean;
    storyMaxUploadBytes: number;
    sitePackageMaxUploadBytes: number;
    clientAddressSource: 'direct' | 'nginx';
    fudabaPublicReadEnabled: boolean;
    fudabaWriteEnabled: boolean;
    fudabaMapEnabled: boolean;
    fudabaMapStyleUrl: string;
}

export interface RuntimeHealth {
    check(): Promise<void>;
}

export interface RuntimeServices extends
    Partial<CacheServices>,
    Partial<EmailServices>,
    Partial<HttpServices>,
    Partial<MediaServices>,
    Partial<ObjectStorageServices>,
    Partial<RepositoryServices>,
    Partial<SecurityServices> {
    fetch?: typeof globalThis.fetch;
    health?: RuntimeHealth;
    config?: Partial<NodeRuntimeConfig>;
}

export interface NodeRuntimeServices extends
    CacheServices,
    EmailServices,
    HttpServices,
    MediaServices,
    ObjectStorageServices,
    RepositoryServices,
    SecurityServices {
    fetch: typeof globalThis.fetch;
    health: RuntimeHealth;
    config: NodeRuntimeConfig;
}

export type ResolveServices<Bindings extends object = Record<string, unknown>> = (
    env: Bindings
) => RuntimeServices | Promise<RuntimeServices>;
