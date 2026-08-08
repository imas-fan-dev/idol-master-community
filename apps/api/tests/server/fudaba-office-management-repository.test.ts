import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PostgresConnection } from '@/infra/db/postgresql/connection';
import { SqlFudabaRepository } from '@/infra/db/repositories/fudaba-repository';
import type {
    ManagedSqlDatabase,
    SqlResult,
    SqlDatabase,
    SqlStatement,
    SqlSchemaStrategy
} from '@/infra/db/sql/database';
import type {
    CreateOwnedFudabaOfficeInput,
    PlatformAccountStatus
} from '@/ports/repositories';
import {
    createPostgresTestHarness,
    postgresIntegrationEnabled
} from '../integration/postgres-harness';
import { seedCanonicalFudabaAgencies } from '../integration/fudaba-agency-fixture';

const CREATED_AT = '2026-08-03T01:00:00.000Z';
const UPDATED_AT = '2026-08-03T02:00:00.000Z';
const LATER_AT = '2026-08-03T03:00:00.000Z';
const RECEIPT_RACE_LOCK = [18_003, 18] as const;

const initializedPostgresSchema: SqlSchemaStrategy = {
    initializeCore: async () => undefined,
    initializePlatform: async () => undefined,
    initializeFudaba: async () => undefined,
    initializeStory: async () => undefined
};

interface Fixture {
    database: ManagedSqlDatabase;
    repository: SqlFudabaRepository;
    dialect: 'sqlite' | 'postgresql';
}

class InterleavingStatement implements SqlStatement {
    constructor(
        private readonly statement: SqlStatement,
        private readonly afterRead: () => Promise<void>
    ) {}

    bind(...values: unknown[]): SqlStatement {
        return new InterleavingStatement(
            this.statement.bind(...values),
            this.afterRead
        );
    }

    async first<Value = Record<string, unknown>>(
        column?: string
    ): Promise<Value | null> {
        const result = await this.statement.first<Value>(column);
        await this.afterRead();
        return result;
    }

    async all<Row = Record<string, unknown>>(): Promise<SqlResult<Row>> {
        const result = await this.statement.all<Row>();
        await this.afterRead();
        return result;
    }

    async run<Row = Record<string, unknown>>(): Promise<SqlResult<Row>> {
        const result = await this.statement.run<Row>();
        await this.afterRead();
        return result;
    }
}

class InterleavingOwnerReadDatabase implements ManagedSqlDatabase {
    private armed = true;

    constructor(
        private readonly database: ManagedSqlDatabase,
        private readonly interleave: () => Promise<void>
    ) {
    }

    prepare(sql: string): SqlStatement {
        const statement = this.database.prepare(sql);
        if (!/\bFROM\s+fudaba_offices(?:\s+office)?\b/i.test(sql) ||
            !/\bowner_account_id\b/i.test(sql)) {
            return statement;
        }
        return new InterleavingStatement(statement, async () => {
            if (!this.armed) return;
            this.armed = false;
            await this.interleave();
        });
    }

    batch<Row = Record<string, unknown>>(
        statements: SqlStatement[]
    ): Promise<SqlResult<Row>[]> {
        return this.database.batch<Row>(statements);
    }

    executeScript(sql: string): Promise<void> {
        return this.database.executeScript(sql);
    }

    transaction<Value>(
        operation: (database: SqlDatabase) => Promise<Value>
    ): Promise<Value> {
        return this.database.transaction(operation);
    }

    close(): Promise<void> {
        return Promise.resolve();
    }
}

function hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

async function createFixture(
    t: TestContext,
    dialect: Fixture['dialect']
): Promise<Fixture> {
    const harness = await createPostgresTestHarness();
    const repository = new SqlFudabaRepository(
        harness.connection,
        initializedPostgresSchema
    );
    t.after(() => harness.close());
    await repository.initialize();
    await seedCanonicalFudabaAgencies(harness.connection);
    return { database: harness.connection, repository, dialect };
}

async function seedAccount(
    fixture: Fixture,
    id: string,
    status: PlatformAccountStatus = 'active'
): Promise<void> {
    await fixture.database.prepare(
        `INSERT INTO platform_accounts
            (id, status, token_version, created_at, updated_at, deleted_at)
         VALUES (?, ?, 0, 1700000000000, 1700000000000, ?)`
    ).bind(id, status, status === 'deleted' ? 1700000000000 : null).run();
}

function office(
    id: string,
    ownerAccountId: string,
    overrides: Partial<CreateOwnedFudabaOfficeInput> = {}
): CreateOwnedFudabaOfficeInput {
    return {
        id,
        ownerAccountId,
        slug: id,
        name: `Office ${id}`,
        intro: 'Owner intro',
        city: 'Shanghai',
        address: '765 Producer Street',
        latitude: 31.2304,
        longitude: 121.4737,
        accent: '#ef5b6c',
        coverObjectKey: null,
        isOpen: true,
        visitorCount: 0,
        status: 'active',
        revision: 0,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
        archivedAt: null,
        seriesCodes: ['765'],
        idempotencyKeyHash: hash(`key:${id}`),
        requestHash: hash(`request:${id}`),
        receiptCreatedAt: 1_775_100_000_000,
        ...overrides
    };
}

async function seedPendingLocation(
    fixture: Fixture,
    officeId: string
): Promise<void> {
    await fixture.database.prepare(
        `INSERT INTO fudaba_office_public_locations
            (office_id, latitude_e1, longitude_e1, review_state, revision,
             submitted_at, reviewed_at, reviewed_by, review_note)
         VALUES (?, 312, 1215, 'pending', 0, ?, NULL, NULL, '')`
    ).bind(officeId, CREATED_AT).run();
}

async function countOrphanedOfficeCreateReceipts(
    fixture: Fixture
): Promise<number> {
    return Number(await fixture.database.prepare(
        `SELECT COUNT(*) AS count
         FROM fudaba_mutation_receipts receipt
         LEFT JOIN fudaba_offices office
           ON office.id=receipt.resource_id
          AND office.owner_account_id=receipt.account_id
         WHERE receipt.scope='office-create' AND office.id IS NULL`
    ).first<number>('count') ?? 0);
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForAdvisoryLockWaiter(fixture: Fixture): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        const waiting = await fixture.database.prepare(
            `SELECT EXISTS (
                 SELECT 1 FROM pg_locks
                 WHERE locktype='advisory' AND NOT granted
                   AND database=(
                       SELECT oid FROM pg_database WHERE datname=current_database()
                   )
             ) AS waiting`
        ).first<boolean>('waiting');
        if (waiting) return;
        await delay(10);
    }
    throw new Error('Timed out waiting for the receipt race advisory lock');
}

async function waitForPostgresLockWait(
    fixture: Fixture,
    processId: number,
    settled: () => boolean
): Promise<boolean> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        if (settled()) return false;
        const activity = await fixture.database.prepare(
            `SELECT wait_event_type FROM pg_stat_activity WHERE pid=?`
        ).bind(processId).first<{ wait_event_type: string | null }>();
        if (activity?.wait_event_type === 'Lock') return true;
        await delay(10);
    }
    throw new Error('Timed out waiting for the account restriction lock');
}

function updateInput(
    officeId: string,
    ownerAccountId: string,
    expectedRevision: number,
    overrides: Record<string, unknown> = {}
) {
    return {
        officeId,
        ownerAccountId,
        name: 'Updated office',
        intro: 'Updated intro',
        city: 'Shanghai',
        address: '765 Producer Street',
        latitude: 31.2304,
        longitude: 121.4737,
        accent: '#4f64dd',
        isOpen: false,
        seriesCodes: ['cg', '765'],
        expectedRevision,
        updatedAt: UPDATED_AT,
        ...overrides
    };
}

async function assertOfficeManagement(fixture: Fixture): Promise<void> {
    const ownerId = `${fixture.dialect}-office-owner`;
    const otherId = `${fixture.dialect}-office-other`;
    const restrictedId = `${fixture.dialect}-office-restricted`;
    await seedAccount(fixture, ownerId);
    await seedAccount(fixture, otherId);
    await seedAccount(fixture, restrictedId, 'restricted');

    assert.deepEqual(await fixture.repository.createOfficeForOwner(office(
        `${fixture.dialect}-restricted-office`,
        restrictedId
    )), { status: 'unavailable' });

    await fixture.database.prepare(
        "UPDATE agencies SET wiki_enabled=FALSE WHERE code='876'"
    ).run();
    const disabled = office(`${fixture.dialect}-disabled-office`, ownerId, {
        seriesCodes: ['876']
    });
    assert.deepEqual(
        await fixture.repository.createOfficeForOwner(disabled),
        { status: 'unavailable' }
    );
    assert.equal(await fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM fudaba_mutation_receipts
         WHERE account_id=? AND key_hash=?`
    ).bind(ownerId, disabled.idempotencyKeyHash).first<number>('count'), 0);
    assert.equal(await fixture.repository.findOfficeById(disabled.id), null);
    assert.equal(await countOrphanedOfficeCreateReceipts(fixture), 0);

    const officeId = `${fixture.dialect}-managed-office`;
    const create = office(officeId, ownerId, {
        seriesCodes: ['765', 'cg']
    });
    const created = await fixture.repository.createOfficeForOwner(create);
    assert.equal(created.status, 'saved');
    if (created.status !== 'saved') return;
    assert.equal(created.office.revision, 0);
    assert.equal(created.office.pending_cover_object_key, null);
    assert.deepEqual(created.office.series_codes, ['765', 'cg']);

    const replayed = await fixture.repository.createOfficeForOwner({
        ...create,
        id: `${officeId}-retry`,
        slug: `${officeId}-retry`
    });
    assert.equal(replayed.status, 'saved');
    if (replayed.status !== 'saved') return;
    assert.equal(replayed.office.id, officeId);
    assert.deepEqual(await fixture.repository.createOfficeForOwner({
        ...create,
        id: `${officeId}-conflict`,
        slug: `${officeId}-conflict`,
        requestHash: hash('different-request')
    }), { status: 'idempotency-conflict' });
    assert.equal(await countOrphanedOfficeCreateReceipts(fixture), 0);
    assert.equal(await fixture.repository.findOfficeForOwner(officeId, otherId), null);
    assert.deepEqual(await fixture.repository.updateOfficeForOwner(updateInput(
        officeId,
        otherId,
        0
    )), { status: 'unavailable' });

    await seedPendingLocation(fixture, officeId);
    const metadata = await fixture.repository.updateOfficeForOwner(updateInput(
        officeId,
        ownerId,
        0
    ));
    assert.equal(metadata.status, 'saved');
    if (metadata.status !== 'saved') return;
    assert.equal(metadata.office.revision, 1);
    assert.deepEqual(metadata.office.series_codes, ['cg', '765']);
    assert.ok(await fixture.repository.findOfficePublicLocationForOwner(
        officeId,
        ownerId
    ), 'unchanged exact location must retain review state');

    const relocated = await fixture.repository.updateOfficeForOwner(updateInput(
        officeId,
        ownerId,
        1,
        { city: 'Hangzhou', updatedAt: LATER_AT }
    ));
    assert.equal(relocated.status, 'saved');
    assert.equal(await fixture.repository.findOfficePublicLocationForOwner(
        officeId,
        ownerId
    ), null, 'city or address changes must withdraw public location review');

    await fixture.database.prepare(
        "UPDATE agencies SET wiki_enabled=FALSE WHERE code='sidem'"
    ).run();
    assert.deepEqual(await fixture.repository.updateOfficeForOwner(updateInput(
        officeId,
        ownerId,
        2,
        { seriesCodes: ['sidem'], updatedAt: LATER_AT }
    )), { status: 'unavailable' });
    const afterRollback = await fixture.repository.findOfficeForOwner(officeId, ownerId);
    assert.equal(afterRollback?.revision, 2);
    assert.deepEqual(afterRollback?.series_codes, ['cg', '765']);
    await fixture.database.prepare(
        "UPDATE agencies SET wiki_enabled=TRUE WHERE code='sidem'"
    ).run();

    const sibling = new SqlFudabaRepository(
        fixture.database,
        initializedPostgresSchema
    );
    await sibling.initialize();
    const first = updateInput(officeId, ownerId, 2, {
        name: 'First writer',
        seriesCodes: ['765'],
        updatedAt: LATER_AT
    });
    const second = updateInput(officeId, ownerId, 2, {
        name: 'Second writer',
        seriesCodes: ['cg', 'sidem'],
        updatedAt: LATER_AT
    });
    const casResults = fixture.dialect === 'postgresql'
        ? await Promise.all([
            fixture.repository.updateOfficeForOwner(first),
            sibling.updateOfficeForOwner(second)
        ])
        : [
            await fixture.repository.updateOfficeForOwner(first),
            await sibling.updateOfficeForOwner(second)
        ];
    assert.deepEqual(
        casResults.map((result) => result.status).sort(),
        ['conflict', 'saved']
    );
    const afterCas = await fixture.repository.findOfficeForOwner(officeId, ownerId);
    assert.equal(afterCas?.revision, 3);
    if (afterCas?.name === 'First writer') {
        assert.deepEqual(afterCas.series_codes, ['765']);
    } else {
        assert.equal(afterCas?.name, 'Second writer');
        assert.deepEqual(afterCas?.series_codes, ['cg', 'sidem']);
    }

    const pendingKey = `community/fudaba/offices/${officeId}/covers/pending.webp`;
    const reserved = await fixture.repository.reservePendingOfficeCoverForOwner({
        officeId,
        ownerAccountId: ownerId,
        objectKey: pendingKey,
        expectedRevision: 3,
        submittedAt: LATER_AT
    });
    assert.equal(reserved.status, 'saved');
    assert.deepEqual(await fixture.repository.reservePendingOfficeCoverForOwner({
        officeId,
        ownerAccountId: ownerId,
        objectKey: `${pendingKey}.second`,
        expectedRevision: 4,
        submittedAt: LATER_AT
    }), { status: 'pending-exists', revision: 4 });
    await fixture.database.prepare(
        `UPDATE platform_accounts
         SET status='restricted', updated_at=1700000000001
         WHERE id=?`
    ).bind(ownerId).run();
    assert.deepEqual(await fixture.repository.clearPendingOfficeCoverForOwner({
        officeId,
        ownerAccountId: ownerId,
        objectKey: `${pendingKey}.wrong`,
        expectedRevision: 4,
        updatedAt: LATER_AT
    }), { status: 'unavailable' });
    assert.deepEqual(await fixture.repository.clearPendingOfficeCoverForOwner({
        officeId,
        ownerAccountId: ownerId,
        objectKey: pendingKey,
        expectedRevision: 3,
        updatedAt: LATER_AT
    }), { status: 'conflict', revision: 4 });
    const cleared = await fixture.repository.clearPendingOfficeCoverForOwner({
        officeId,
        ownerAccountId: ownerId,
        objectKey: pendingKey,
        expectedRevision: 4,
        updatedAt: LATER_AT
    });
    assert.equal(cleared.status, 'saved');
    if (cleared.status !== 'saved') return;
    assert.equal(cleared.previousPendingObjectKey, pendingKey);
    assert.equal(cleared.office.pending_cover_object_key, null);
    await fixture.database.prepare(
        `UPDATE platform_accounts
         SET status='active', deleted_at=NULL, updated_at=1700000000002
         WHERE id=?`
    ).bind(ownerId).run();

    await fixture.database.prepare(
        "UPDATE fudaba_offices SET status='hidden' WHERE id=?"
    ).bind(officeId).run();
    for (const result of [
        await fixture.repository.updateOfficeForOwner(updateInput(
            officeId,
            ownerId,
            5
        )),
        await fixture.repository.reservePendingOfficeCoverForOwner({
            officeId,
            ownerAccountId: ownerId,
            objectKey: `${pendingKey}.hidden`,
            expectedRevision: 5,
            submittedAt: LATER_AT
        }),
        await fixture.repository.archiveOfficeForOwner({
            officeId,
            ownerAccountId: ownerId,
            expectedRevision: 5,
            archivedAt: LATER_AT
        }),
        await fixture.repository.restoreOfficeForOwner({
            officeId,
            ownerAccountId: ownerId,
            expectedRevision: 5,
            restoredAt: LATER_AT
        })
    ]) {
        assert.deepEqual(result, {
            status: 'state-conflict',
            revision: 5,
            officeStatus: 'hidden'
        });
    }
    await fixture.database.prepare(
        "UPDATE fudaba_offices SET status='active' WHERE id=?"
    ).bind(officeId).run();
    const archived = await fixture.repository.archiveOfficeForOwner({
        officeId,
        ownerAccountId: ownerId,
        expectedRevision: 5,
        archivedAt: LATER_AT
    });
    assert.equal(archived.status, 'saved');
    assert.deepEqual(await fixture.repository.reservePendingOfficeCoverForOwner({
        officeId,
        ownerAccountId: ownerId,
        objectKey: `${pendingKey}.archived`,
        expectedRevision: 6,
        submittedAt: LATER_AT
    }), {
        status: 'state-conflict',
        revision: 6,
        officeStatus: 'archived'
    });
    const restored = await fixture.repository.restoreOfficeForOwner({
        officeId,
        ownerAccountId: ownerId,
        expectedRevision: 6,
        restoredAt: LATER_AT
    });
    assert.equal(restored.status, 'saved');
    const deletedPendingKey = `${pendingKey}.deleted-owner`;
    const reservedBeforeDeletion =
        await fixture.repository.reservePendingOfficeCoverForOwner({
            officeId,
            ownerAccountId: ownerId,
            objectKey: deletedPendingKey,
            expectedRevision: 7,
            submittedAt: LATER_AT
        });
    assert.equal(reservedBeforeDeletion.status, 'saved');
    await fixture.database.prepare(
        `UPDATE platform_accounts
         SET status='deleted', deleted_at=1700000000003,
             updated_at=1700000000003
         WHERE id=?`
    ).bind(ownerId).run();
    const clearedAfterDeletion =
        await fixture.repository.clearPendingOfficeCoverForOwner({
            officeId,
            ownerAccountId: ownerId,
            objectKey: deletedPendingKey,
            expectedRevision: 8,
            updatedAt: LATER_AT
        });
    assert.equal(clearedAfterDeletion.status, 'saved');
    if (clearedAfterDeletion.status === 'saved') {
        assert.equal(clearedAfterDeletion.office.revision, 9);
        assert.equal(clearedAfterDeletion.office.pending_cover_object_key, null);
    }
    assert.deepEqual(
        (await fixture.repository.listOfficesForOwner(ownerId)).map(({ id }) => id),
        [officeId]
    );
}

test('real PostgreSQL owner offices enforce receipt and cross-replica CAS', {
    skip: !postgresIntegrationEnabled() &&
        'set IMS_TEST_POSTGRES_ADMIN_URL to a local PostgreSQL admin database'
}, async (t) => {
    await assertOfficeManagement(await createFixture(t, 'postgresql'));
});

async function assertOwnerOfficeReadsUseOneSnapshot(fixture: Fixture): Promise<void> {
    const ownerId = `${fixture.dialect}-snapshot-owner`;
    const officeId = `${fixture.dialect}-snapshot-office`;
    await seedAccount(fixture, ownerId);
    const created = await fixture.repository.createOfficeForOwner(office(
        officeId,
        ownerId,
        { name: 'Version zero', seriesCodes: ['765'] }
    ));
    assert.equal(created.status, 'saved');

    let firstInterleaved = false;
    const firstReader = new SqlFudabaRepository(
        new InterleavingOwnerReadDatabase(fixture.database, async () => {
            firstInterleaved = true;
            const updated = await fixture.repository.updateOfficeForOwner(updateInput(
                officeId,
                ownerId,
                0,
                { name: 'Version one', seriesCodes: ['cg'] }
            ));
            assert.equal(updated.status, 'saved');
        }),
        initializedPostgresSchema
    );
    await firstReader.initialize();
    const firstSnapshot = await firstReader.findOfficeForOwner(officeId, ownerId);
    assert.equal(firstInterleaved, true);
    assert.deepEqual(
        [firstSnapshot?.revision, firstSnapshot?.name, firstSnapshot?.series_codes],
        [0, 'Version zero', ['765']]
    );

    let secondInterleaved = false;
    const secondReader = new SqlFudabaRepository(
        new InterleavingOwnerReadDatabase(fixture.database, async () => {
            secondInterleaved = true;
            const updated = await fixture.repository.updateOfficeForOwner(updateInput(
                officeId,
                ownerId,
                1,
                { name: 'Version two', seriesCodes: ['sidem'] }
            ));
            assert.equal(updated.status, 'saved');
        }),
        initializedPostgresSchema
    );
    await secondReader.initialize();
    const listedSnapshot = (await secondReader.listOfficesForOwner(ownerId))[0];
    assert.equal(secondInterleaved, true);
    assert.deepEqual(
        [listedSnapshot?.revision, listedSnapshot?.name, listedSnapshot?.series_codes],
        [1, 'Version one', ['cg']]
    );
    const current = await fixture.repository.findOfficeForOwner(officeId, ownerId);
    assert.deepEqual(
        [current?.revision, current?.name, current?.series_codes],
        [2, 'Version two', ['sidem']]
    );
}

test('real PostgreSQL owner reads keep metadata and series in one snapshot', {
    skip: !postgresIntegrationEnabled() &&
        'set IMS_TEST_POSTGRES_ADMIN_URL to a local PostgreSQL admin database'
}, async (t) => {
    await assertOwnerOfficeReadsUseOneSnapshot(await createFixture(t, 'postgresql'));
});

test('real PostgreSQL owner lock keeps office-create receipts atomic', {
    skip: !postgresIntegrationEnabled() &&
        'set IMS_TEST_POSTGRES_ADMIN_URL to a local PostgreSQL admin database'
}, async (t) => {
    const fixture = await createFixture(t, 'postgresql');
    const ownerId = 'postgresql-receipt-race-owner';
    const officeId = 'postgresql-receipt-race-office';
    const createInput = office(officeId, ownerId);
    await seedAccount(fixture, ownerId);
    await fixture.database.executeScript(`
        CREATE FUNCTION public.fudaba_test_hold_office_create_receipt()
        RETURNS TRIGGER
        LANGUAGE plpgsql
        AS $$
        BEGIN
            PERFORM pg_advisory_xact_lock(
                ${RECEIPT_RACE_LOCK[0]}, ${RECEIPT_RACE_LOCK[1]}
            );
            RETURN NEW;
        END;
        $$;

        CREATE TRIGGER fudaba_test_hold_office_create_receipt
        AFTER INSERT ON public.fudaba_mutation_receipts
        FOR EACH ROW
        EXECUTE FUNCTION public.fudaba_test_hold_office_create_receipt();
    `);

    const postgres = fixture.database as PostgresConnection;
    const controller = await postgres.pool.connect();
    const updater = await postgres.pool.connect();
    const updaterProcessId = Number((await updater.query(
        'SELECT pg_backend_pid() AS pid'
    )).rows[0]?.pid);
    let controllerLocked = false;
    let restrictionAttempt: Promise<unknown> | undefined;
    await controller.query(
        'SELECT pg_advisory_lock($1, $2)',
        [...RECEIPT_RACE_LOCK]
    );
    controllerLocked = true;
    const createAttempt = fixture.repository.createOfficeForOwner(createInput);
    try {
        await waitForAdvisoryLockWaiter(fixture);
        let restrictionSettled = false;
        restrictionAttempt = updater.query(
            `UPDATE platform_accounts
             SET status='restricted', updated_at=1700000000001
             WHERE id=$1`,
            [ownerId]
        ).finally(() => {
            restrictionSettled = true;
        });
        const restrictionWasBlocked = await waitForPostgresLockWait(
            fixture,
            updaterProcessId,
            () => restrictionSettled
        );
        await controller.query(
            'SELECT pg_advisory_unlock($1, $2)',
            [...RECEIPT_RACE_LOCK]
        );
        controllerLocked = false;

        const [created] = await Promise.all([createAttempt, restrictionAttempt]);
        assert.equal(
            restrictionWasBlocked,
            true,
            'account restriction must wait for receipt and office to commit'
        );
        assert.equal(created.status, 'saved');
        assert.ok(await fixture.repository.findOfficeForOwner(officeId, ownerId));
        assert.equal(await fixture.database.prepare(
            `SELECT COUNT(*) AS count FROM fudaba_mutation_receipts
             WHERE scope='office-create' AND account_id=? AND key_hash=?
               AND resource_id=?`
        ).bind(
            ownerId,
            createInput.idempotencyKeyHash,
            officeId
        ).first<number>('count'), 1);
        assert.equal(await countOrphanedOfficeCreateReceipts(fixture), 0);
    } finally {
        if (controllerLocked) {
            await controller.query(
                'SELECT pg_advisory_unlock($1, $2)',
                [...RECEIPT_RACE_LOCK]
            ).catch(() => undefined);
        }
        await Promise.allSettled([
            createAttempt,
            ...(restrictionAttempt ? [restrictionAttempt] : [])
        ]);
        updater.release();
        controller.release();
    }
});
