import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import {
    createPostgresTestHarness,
    postgresIntegrationEnabled,
    type PostgresTestHarness
} from '../integration/postgres-harness';
import { seedCanonicalFudabaAgencies } from '../integration/fudaba-agency-fixture';

const require = createRequire(__filename);
const { migratePostgres } = require(
    '../../scripts/migration/postgres-migrations.js'
) as {
    migratePostgres(options: {
        connectionString: string;
        migrationsPath?: string;
    }): Promise<unknown>;
};

const POSTGRES_MIGRATIONS = path.join(
    __dirname,
    '../../migrations/postgresql'
);

async function createLegacyMigrations(t: TestContext): Promise<string> {
    const target = await fs.mkdtemp(
        path.join(os.tmpdir(), 'ims-fudaba-pg-0026-')
    );
    t.after(() => fs.rm(target, { recursive: true, force: true }));
    const names = (await fs.readdir(POSTGRES_MIGRATIONS))
        .filter((name) => Number.parseInt(name.slice(0, 4), 10) <= 26);
    await Promise.all(names.map((name) => fs.copyFile(
        path.join(POSTGRES_MIGRATIONS, name),
        path.join(target, name)
    )));
    return target;
}

async function createLegacyHarness(
    t: TestContext
): Promise<PostgresTestHarness> {
    const harness = await createPostgresTestHarness({
        migrationsPath: await createLegacyMigrations(t),
        seedCanonicalAgencies: false
    });
    t.after(() => harness.close());
    await seedCanonicalFudabaAgencies(harness.connection);
    await harness.connection.prepare(
        `INSERT INTO platform_accounts
            (id, status, token_version, created_at, updated_at, deleted_at)
         VALUES ('agency-migration-owner', 'active', 0, 1700000000000,
                 1700000000000, NULL)`
    ).run();
    await harness.connection.prepare(
        `INSERT INTO fudaba_offices
            (id, owner_account_id, slug, name, intro, city, address,
             latitude, longitude, accent, cover_object_key, is_open,
             visitor_count, status, revision, created_at, updated_at,
             archived_at)
         VALUES
            ('agency-migration-office', 'agency-migration-owner',
             'agency-migration-office', 'Migration Office', '', 'Shanghai',
             'Migration Street', 31.23, 121.47, '#ef5b6c', NULL, TRUE,
             0, 'active', 0, '2026-08-03T00:00:00.000Z',
             '2026-08-03T00:00:00.000Z', NULL)`
    ).run();
    return harness;
}

test('PostgreSQL 0027 maps associated Fudaba series to canonical agencies', {
    skip: !postgresIntegrationEnabled()
}, async (t) => {
    const harness = await createLegacyHarness(t);
    const mappings = [
        ['765as', '765'],
        ['cinderella', 'cg'],
        ['million-live', 'ml'],
        ['sidem', 'sidem'],
        ['shiny-colors', 'sc'],
        ['gakuen', 'gk']
    ] as const;
    for (const [index, [legacyCode]] of mappings.entries()) {
        await harness.connection.prepare(
            `INSERT INTO fudaba_office_series_tags
                (office_id, series_code, display_order)
             VALUES ('agency-migration-office', ?, ?)`
        ).bind(legacyCode, index).run();
        await harness.connection.prepare(
            `INSERT INTO fudaba_cards
                (id, owner_account_id, producer_name, display_name,
                 series_code, favorite_idol, front_object_key,
                 back_object_key, accent, bio, trade_note, available,
                 source_url, source_label, source_credit, media_rights_status,
                 publication_status, revision, created_at, updated_at,
                 deleted_at)
             VALUES (?, 'agency-migration-owner', 'Producer', ?, ?, '', ?, ?,
                     '#4f64dd', '', '', TRUE, NULL, NULL, NULL, 'approved',
                     'published', 0, '2026-08-03T00:00:00.000Z',
                     '2026-08-03T00:00:00.000Z', NULL)`
        ).bind(
            `agency-card-${index}`,
            `Agency Card ${index}`,
            legacyCode,
            `cards/agency-card-${index}/front.webp`,
            `cards/agency-card-${index}/back.webp`
        ).run();
    }

    await migratePostgres({ connectionString: harness.databaseUrl });

    const expectedCodes = mappings.map(([, code]) => code).sort();
    const officeCodes = await harness.connection.prepare(
        `SELECT series_code
         FROM fudaba_office_series_tags
         WHERE office_id='agency-migration-office'
         ORDER BY series_code`
    ).all<{ series_code: string }>();
    const cardCodes = await harness.connection.prepare(
        `SELECT series_code
         FROM fudaba_cards
         WHERE owner_account_id='agency-migration-owner'
         ORDER BY series_code`
    ).all<{ series_code: string }>();
    assert.deepEqual(
        officeCodes.results.map(({ series_code }) => series_code),
        expectedCodes
    );
    assert.deepEqual(
        cardCodes.results.map(({ series_code }) => series_code),
        expectedCodes
    );
    assert.equal(await harness.connection.prepare(
        `SELECT to_regclass('public.fudaba_series_tags') AS table_name`
    ).first<string>('table_name'), null);

    const foreignKeys = await harness.connection.prepare(
        `SELECT source.relname AS source_table,
                target.relname AS target_table
         FROM pg_constraint constraint_record
         JOIN pg_class source ON source.oid=constraint_record.conrelid
         JOIN pg_class target ON target.oid=constraint_record.confrelid
         WHERE constraint_record.contype='f'
           AND constraint_record.conname IN (
               'fudaba_office_series_tags_series_code_fkey',
               'fudaba_cards_series_code_fkey'
           )
         ORDER BY source.relname`
    ).all<{ source_table: string; target_table: string }>();
    assert.deepEqual(foreignKeys.results, [
        { source_table: 'fudaba_cards', target_table: 'agencies' },
        {
            source_table: 'fudaba_office_series_tags',
            target_table: 'agencies'
        }
    ]);
});

test('PostgreSQL 0027 blocks associated valiv instead of mapping it to 876', {
    skip: !postgresIntegrationEnabled()
}, async (t) => {
    const harness = await createLegacyHarness(t);
    await harness.connection.prepare(
        `INSERT INTO fudaba_office_series_tags
            (office_id, series_code, display_order)
         VALUES ('agency-migration-office', 'valiv', 0)`
    ).run();

    await assert.rejects(
        migratePostgres({ connectionString: harness.databaseUrl }),
        /FUDABA_VALIV_AGENCY_RECONCILIATION_REQUIRED/
    );
    assert.equal(await harness.connection.prepare(
        `SELECT series_code
         FROM fudaba_office_series_tags
         WHERE office_id='agency-migration-office'`
    ).first<string>('series_code'), 'valiv');
    assert.notEqual(await harness.connection.prepare(
        `SELECT to_regclass('public.fudaba_series_tags') AS table_name`
    ).first<string>('table_name'), null);
});
