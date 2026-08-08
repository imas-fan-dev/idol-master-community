import type {
    ManagedSqlDatabase,
    SqlSchemaStrategy
} from '@/infra/db/sql/database';

export const REQUIRED_POSTGRESQL_SCHEMA_VERSION =
    '20260805090000_wiki_story_content_type_icons';

export class PostgresqlSchemaStrategy implements SqlSchemaStrategy {
    private readonly verifications = new WeakMap<ManagedSqlDatabase, Promise<void>>();

    private verify(database: ManagedSqlDatabase): Promise<void> {
        const existing = this.verifications.get(database);
        if (existing) return existing;
        const verification = this.verifyCurrent(database);
        this.verifications.set(database, verification);
        return verification;
    }

    private async verifyCurrent(database: ManagedSqlDatabase): Promise<void> {
        let migration: { version: string } | null;
        try {
            migration = await database.prepare(
                'SELECT version FROM ims_schema_migrations WHERE version=?'
            ).bind(REQUIRED_POSTGRESQL_SCHEMA_VERSION).first<{ version: string }>();
        } catch (error) {
            throw new Error(
                'PostgreSQL schema is not initialized; run pnpm run migration:postgresql',
                { cause: error }
            );
        }
        if (!migration) {
            throw new Error(
                `PostgreSQL schema migration ${REQUIRED_POSTGRESQL_SCHEMA_VERSION} is required; ` +
                'run pnpm run migration:postgresql'
            );
        }
    }

    initializeCore(database: ManagedSqlDatabase): Promise<void> {
        return this.verify(database);
    }

    initializePlatform(database: ManagedSqlDatabase): Promise<void> {
        return this.verify(database);
    }

    initializeFudaba(database: ManagedSqlDatabase): Promise<void> {
        return this.verify(database);
    }

    initializeStory(database: ManagedSqlDatabase): Promise<void> {
        return this.verify(database);
    }
}
