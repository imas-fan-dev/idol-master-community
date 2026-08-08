import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { Pool } from 'pg';
import { PostgresConnection } from '@/infra/db/postgresql/connection';
import { seedCanonicalFudabaAgencies } from './fudaba-agency-fixture';

const require = createRequire(__filename);
const { migratePostgres } = require('../../scripts/migration/postgres-migrations.js') as {
    migratePostgres(options: {
        connectionString: string;
        migrationsPath?: string;
    }): Promise<unknown>;
};

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export interface PostgresTestHarness {
    connection: PostgresConnection;
    databaseName: string;
    databaseUrl: string;
    close(): Promise<void>;
}

export interface PostgresTestHarnessOptions {
    migrationsPath?: string;
    seedCanonicalAgencies?: boolean;
}

function quotedIdentifier(value: string): string {
    if (!/^[a-z][a-z0-9_]+$/.test(value)) {
        throw new Error(`Unsafe PostgreSQL test database identifier: ${value}`);
    }
    return `"${value}"`;
}

export function postgresIntegrationEnabled(): boolean {
    return true;
}

export async function createPostgresTestHarness(
    options: PostgresTestHarnessOptions = {}
): Promise<PostgresTestHarness> {
    const adminValue = process.env.IMS_TEST_POSTGRES_ADMIN_URL?.trim() ||
        process.env.IMS_TEST_DATABASE_URL?.trim() ||
        'postgresql://imsweb:imsweb-local-password@127.0.0.1:5432/postgres';
    const adminUrl = new URL(adminValue);
    if (
        !['postgres:', 'postgresql:'].includes(adminUrl.protocol) ||
        !LOOPBACK_HOSTS.has(adminUrl.hostname)
    ) {
        throw new Error(
            'IMS_TEST_POSTGRES_ADMIN_URL must target PostgreSQL on the local loopback interface'
        );
    }

    const databaseName = [
        'imsweb_s2_platform',
        process.pid,
        Date.now(),
        randomBytes(4).toString('hex')
    ].join('_');
    const identifier = quotedIdentifier(databaseName);
    const admin = new Pool({
        connectionString: adminUrl.toString(),
        max: 1,
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 5_000,
        allowExitOnIdle: true,
        application_name: 'imsweb-platform-session-test-admin'
    });
    try {
        await admin.query(`CREATE DATABASE ${identifier} TEMPLATE template0`);
    } catch (error) {
        await admin.end();
        throw error;
    }

    const databaseUrl = new URL(adminUrl);
    databaseUrl.pathname = `/${databaseName}`;
    const connection = PostgresConnection.create({
        connectionString: databaseUrl.toString(),
        maxConnections: 4,
        idleTimeoutMs: 5_000,
        connectionTimeoutMs: 5_000,
        statementTimeoutMs: 30_000,
        idleInTransactionTimeoutMs: 30_000
    });
    let closed = false;
    try {
        await migratePostgres({
            connectionString: databaseUrl.toString(),
            migrationsPath: options.migrationsPath
        });
        if (options.seedCanonicalAgencies !== false) {
            await seedCanonicalFudabaAgencies(connection);
        }
    } catch (error) {
        await connection.close().catch(() => undefined);
        await admin.query(`DROP DATABASE IF EXISTS ${identifier} WITH (FORCE)`)
            .catch(() => undefined);
        await admin.end();
        throw error;
    }

    return {
        connection,
        databaseName,
        databaseUrl: databaseUrl.toString(),
        async close() {
            if (closed) return;
            closed = true;
            try {
                await connection.close();
                await admin.query(
                    `SELECT pg_terminate_backend(pid)
                     FROM pg_stat_activity
                     WHERE datname=$1 AND pid<>pg_backend_pid()`,
                    [databaseName]
                );
                await admin.query(`DROP DATABASE ${identifier}`);
            } finally {
                await admin.end();
            }
        }
    };
}
