import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { SqlCoreRepository } from '@/infra/db/repositories/core-repository';
import { SqlFudabaRepository } from '@/infra/db/repositories/fudaba-repository';
import type {
    ManagedSqlDatabase,
    SqlSchemaStrategy
} from '@/infra/db/sql/database';
import type {
    NewFudabaOfficeInput,
    PlatformAccountStatus
} from '@/ports/repositories';
import {
    createPostgresTestHarness,
    postgresIntegrationEnabled
} from '../integration/postgres-harness';
import { seedCanonicalFudabaAgencies } from '../integration/fudaba-agency-fixture';

const SUBMITTED_AT = '2026-08-03T01:00:00.000Z';
const RESUBMITTED_AT = '2026-08-03T02:00:00.000Z';
const REVIEWED_AT = '2026-08-03T03:00:00.000Z';
const PUBLISH_OPERATION_ID = '00000000-0000-4000-8000-000000000001';
const STALE_OPERATION_ID = '00000000-0000-4000-8000-000000000002';
const FAILED_OPERATION_ID = '00000000-0000-4000-8000-000000000003';

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
    overrides: Partial<NewFudabaOfficeInput> = {}
): NewFudabaOfficeInput {
    return {
        id,
        ownerAccountId,
        slug: id,
        name: `Office ${id}`,
        intro: 'Private intro',
        city: 'Shanghai',
        address: 'Private exact address',
        latitude: 31.2304,
        longitude: 121.4737,
        accent: '#ef5b6c',
        coverObjectKey: null,
        isOpen: true,
        visitorCount: 0,
        status: 'active',
        revision: 0,
        createdAt: SUBMITTED_AT,
        updatedAt: SUBMITTED_AT,
        archivedAt: null,
        seriesCodes: ['765'],
        ...overrides
    };
}

async function seedReviewer(fixture: Fixture): Promise<number> {
    const table = fixture.dialect === 'sqlite' ? 'users' : 'backoffice_accounts';
    const row = await fixture.database.prepare(
        `INSERT INTO ${table}
            (username, password, dept, producername, admin_role)
         VALUES (?, 'hash', 'op', 'Reviewer', 'admin')
         RETURNING id`
    ).bind(`${fixture.dialect}-location-reviewer`).first<{ id: number }>();
    assert.ok(row);
    return Number(row.id);
}

async function insertReviewedLocation(
    fixture: Fixture,
    input: {
        officeId: string;
        latitudeE1: number;
        longitudeE1: number;
        reviewerId: number;
        state?: 'published' | 'rejected';
        note?: string;
    }
): Promise<void> {
    await fixture.database.prepare(
        `INSERT INTO fudaba_office_public_locations
            (office_id, latitude_e1, longitude_e1, review_state, revision,
             submitted_at, reviewed_at, reviewed_by, review_note, review_audit_id)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`
    ).bind(
        input.officeId,
        input.latitudeE1,
        input.longitudeE1,
        input.state ?? 'published',
        SUBMITTED_AT,
        REVIEWED_AT,
        input.reviewerId,
        input.note ?? '',
        crypto.randomUUID()
    ).run();
}

function reviewAudit(target: string) {
    return {
        username: 'location-reviewer',
        producername: 'Reviewer',
        action: '发布 Fudaba 事务所公开位置',
        target,
        ip: '127.0.0.1',
        time: REVIEWED_AT
    };
}

async function installFailingAuditTrigger(fixture: Fixture): Promise<void> {
    if (fixture.dialect === 'sqlite') {
        await fixture.database.executeScript(`
            CREATE TRIGGER fail_fudaba_location_audit
            BEFORE INSERT ON logs
            BEGIN
                SELECT RAISE(FAIL, 'forced Fudaba location audit failure');
            END;
        `);
        return;
    }
    await fixture.database.executeScript(`
        CREATE FUNCTION fail_fudaba_location_audit()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'forced Fudaba location audit failure';
        END;
        $$;
        CREATE TRIGGER fail_fudaba_location_audit
        BEFORE INSERT ON logs
        FOR EACH ROW EXECUTE FUNCTION fail_fudaba_location_audit();
    `);
}

async function removeFailingAuditTrigger(fixture: Fixture): Promise<void> {
    if (fixture.dialect === 'sqlite') {
        await fixture.database.executeScript(
            'DROP TRIGGER fail_fudaba_location_audit;'
        );
        return;
    }
    await fixture.database.executeScript(`
        DROP TRIGGER fail_fudaba_location_audit ON logs;
        DROP FUNCTION fail_fudaba_location_audit();
    `);
}

async function assertLocationRepository(
    t: TestContext,
    dialect: Fixture['dialect']
): Promise<void> {
    const fixture = await createFixture(t, dialect);
    const ownerId = `${dialect}-location-owner`;
    const otherId = `${dialect}-location-other`;
    const restrictedId = `${dialect}-location-restricted`;
    const suspendedId = `${dialect}-location-suspended`;
    await seedAccount(fixture, ownerId);
    await seedAccount(fixture, otherId);
    await seedAccount(fixture, restrictedId, 'restricted');
    await seedAccount(fixture, suspendedId, 'suspended');
    const reviewerId = await seedReviewer(fixture);

    await fixture.repository.createOffice(office('location-main', ownerId));
    await fixture.repository.createOffice(office('location-hidden', ownerId, {
        status: 'hidden'
    }));
    await fixture.repository.createOffice(office('location-archived', ownerId, {
        status: 'archived',
        archivedAt: RESUBMITTED_AT
    }));
    await fixture.database.prepare(
        `INSERT INTO fudaba_office_public_locations
            (office_id, latitude_e1, longitude_e1, review_state, revision,
             submitted_at, reviewed_at, reviewed_by, review_note)
         VALUES ('location-hidden', 300, 1200, 'pending', 0, ?, NULL, NULL, '')`
    ).bind(SUBMITTED_AT).run();

    const created = await fixture.repository.saveOfficePublicLocationForOwner({
        officeId: 'location-main',
        ownerAccountId: ownerId,
        latitudeE1: 312,
        longitudeE1: 1215,
        expectedRevision: null,
        submittedAt: SUBMITTED_AT
    });
    assert.equal(created.status, 'saved');
    if (created.status !== 'saved') return;
    assert.deepEqual(created.location, {
        office_id: 'location-main',
        latitude_e1: 312,
        longitude_e1: 1215,
        review_state: 'pending',
        revision: 0,
        submitted_at: SUBMITTED_AT,
        reviewed_at: null,
        reviewed_by: null,
        review_note: ''
    });
    assert.deepEqual(await fixture.repository.saveOfficePublicLocationForOwner({
        officeId: 'location-main',
        ownerAccountId: otherId,
        latitudeE1: 300,
        longitudeE1: 1200,
        expectedRevision: 0,
        submittedAt: RESUBMITTED_AT
    }), { status: 'unavailable' });
    for (const officeId of ['location-hidden', 'location-archived']) {
        assert.deepEqual(await fixture.repository.saveOfficePublicLocationForOwner({
            officeId,
            ownerAccountId: ownerId,
            latitudeE1: 300,
            longitudeE1: 1200,
            expectedRevision: null,
            submittedAt: RESUBMITTED_AT
        }), { status: 'unavailable' });
    }

    const published = await fixture.repository.reviewOfficePublicLocation({
        officeId: 'location-main',
        decision: 'publish',
        expectedRevision: 0,
        reviewedAt: REVIEWED_AT,
        reviewedBy: reviewerId,
        reviewNote: '',
        reviewOperationId: PUBLISH_OPERATION_ID,
        audit: reviewAudit('location-main@1')
    });
    assert.equal(published.status, 'saved');
    assert.deepEqual(await fixture.database.prepare(
        `SELECT username, producername, action, target, ip, time
         FROM logs WHERE target='location-main@1'`
    ).first(), reviewAudit('location-main@1'));
    assert.deepEqual(await fixture.repository.reviewOfficePublicLocation({
        officeId: 'location-main',
        decision: 'reject',
        expectedRevision: 0,
        reviewedAt: REVIEWED_AT,
        reviewedBy: reviewerId,
        reviewNote: 'stale',
        reviewOperationId: STALE_OPERATION_ID,
        audit: { ...reviewAudit('location-main@stale'), action: 'stale review' }
    }), { status: 'conflict', revision: 1 });
    assert.equal(await fixture.database.prepare(
        'SELECT COUNT(*) AS count FROM logs'
    ).first<number>('count'), 1, 'stale review must not write an audit log');

    await fixture.repository.createOffice(office('location-audit-failure', ownerId));
    assert.equal((await fixture.repository.saveOfficePublicLocationForOwner({
        officeId: 'location-audit-failure',
        ownerAccountId: ownerId,
        latitudeE1: 300,
        longitudeE1: 1200,
        expectedRevision: null,
        submittedAt: SUBMITTED_AT
    })).status, 'saved');
    await installFailingAuditTrigger(fixture);
    await assert.rejects(fixture.repository.reviewOfficePublicLocation({
        officeId: 'location-audit-failure',
        decision: 'publish',
        expectedRevision: 0,
        reviewedAt: REVIEWED_AT,
        reviewedBy: reviewerId,
        reviewNote: '',
        reviewOperationId: FAILED_OPERATION_ID,
        audit: reviewAudit('location-audit-failure@1')
    }), /forced Fudaba location audit failure/);
    await removeFailingAuditTrigger(fixture);
    const auditFailureLocation = await fixture.repository
        .findOfficePublicLocationForOwner('location-audit-failure', ownerId);
    assert.equal(auditFailureLocation?.review_state, 'pending');
    assert.equal(auditFailureLocation?.revision, 0);
    assert.equal(await fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM logs
         WHERE target='location-audit-failure@1'`
    ).first<number>('count'), 0);
    assert.equal((await fixture.repository.withdrawOfficePublicLocationForOwner({
        officeId: 'location-audit-failure',
        ownerAccountId: ownerId,
        expectedRevision: 0
    })).status, 'saved');

    const resubmitted = await fixture.repository.saveOfficePublicLocationForOwner({
        officeId: 'location-main',
        ownerAccountId: ownerId,
        latitudeE1: 313,
        longitudeE1: 1216,
        expectedRevision: 1,
        submittedAt: RESUBMITTED_AT
    });
    assert.equal(resubmitted.status, 'saved');
    if (resubmitted.status !== 'saved') return;
    assert.equal(resubmitted.location.revision, 2);
    assert.equal(resubmitted.location.review_state, 'pending');
    assert.equal(resubmitted.location.reviewed_at, null);
    assert.equal(resubmitted.location.reviewed_by, null);
    assert.equal(resubmitted.location.review_note, '');
    assert.equal(await fixture.database.prepare(
        `SELECT review_audit_id FROM fudaba_office_public_locations
         WHERE office_id='location-main'`
    ).first<string>('review_audit_id'), null);

    const sibling = new SqlFudabaRepository(fixture.database, initializedPostgresSchema);
    await sibling.initialize();
    const concurrent = await Promise.all([
        fixture.repository.saveOfficePublicLocationForOwner({
            officeId: 'location-main',
            ownerAccountId: ownerId,
            latitudeE1: 314,
            longitudeE1: 1217,
            expectedRevision: 2,
            submittedAt: REVIEWED_AT
        }),
        sibling.saveOfficePublicLocationForOwner({
            officeId: 'location-main',
            ownerAccountId: ownerId,
            latitudeE1: 315,
            longitudeE1: 1218,
            expectedRevision: 2,
            submittedAt: REVIEWED_AT
        })
    ]);
    assert.deepEqual(
        concurrent.map((result) => result.status).sort(),
        ['conflict', 'saved']
    );
    const current = await fixture.repository.findOfficePublicLocationForOwner(
        'location-main',
        ownerId
    );
    assert.equal(current?.revision, 3);

    await fixture.database.prepare(
        "UPDATE fudaba_offices SET status='archived', archived_at=? WHERE id=?"
    ).bind(REVIEWED_AT, 'location-main').run();
    const withdrawn = await fixture.repository.withdrawOfficePublicLocationForOwner({
        officeId: 'location-main',
        ownerAccountId: ownerId,
        expectedRevision: 3
    });
    assert.equal(withdrawn.status, 'saved');
    assert.equal(await fixture.repository.findOfficePublicLocationForOwner(
        'location-main',
        ownerId
    ), null);

    await fixture.database.prepare(
        "UPDATE agencies SET wiki_enabled=? WHERE code='sidem'"
    ).bind(dialect === 'sqlite' ? 0 : false).run();
    const publicInputs = [
        office('map-negative', ownerId, { city: 'Beijing', isOpen: false }),
        office('map-positive', ownerId),
        office('map-restricted', restrictedId),
        office('map-suspended', suspendedId),
        office('map-hidden-office', ownerId, { status: 'hidden' }),
        office('map-disabled-series', ownerId, { seriesCodes: ['sidem'] }),
        office('map-pending', ownerId)
    ];
    for (const input of publicInputs) await fixture.repository.createOffice(input);
    await insertReviewedLocation(fixture, {
        officeId: 'map-negative', latitudeE1: -32, longitudeE1: -456, reviewerId
    });
    await insertReviewedLocation(fixture, {
        officeId: 'map-positive', latitudeE1: 312, longitudeE1: 1215, reviewerId
    });
    await insertReviewedLocation(fixture, {
        officeId: 'map-restricted', latitudeE1: 313, longitudeE1: 1216, reviewerId
    });
    await insertReviewedLocation(fixture, {
        officeId: 'map-suspended', latitudeE1: 314, longitudeE1: 1217, reviewerId
    });
    await insertReviewedLocation(fixture, {
        officeId: 'map-hidden-office', latitudeE1: 315, longitudeE1: 1218, reviewerId
    });
    await insertReviewedLocation(fixture, {
        officeId: 'map-disabled-series', latitudeE1: 316, longitudeE1: 1219, reviewerId
    });
    assert.equal((await fixture.repository.saveOfficePublicLocationForOwner({
        officeId: 'map-pending',
        ownerAccountId: ownerId,
        latitudeE1: 317,
        longitudeE1: 1220,
        expectedRevision: null,
        submittedAt: SUBMITTED_AT
    })).status, 'saved');

    const worldwide = await fixture.repository.listPublicMapOffices({
        bbox: { westE1: -1800, southE1: -900, eastE1: 1800, northE1: 900 },
        limit: 20
    });
    assert.deepEqual(worldwide.map(({ id }) => id), [
        'map-negative',
        'map-positive',
        'map-restricted'
    ]);
    const mapRecord = worldwide[1] as unknown as Record<string, unknown>;
    for (const privateKey of [
        'owner_account_id', 'address', 'latitude', 'longitude',
        'review_state', 'reviewed_by', 'review_note', 'review_audit_id'
    ]) {
        assert.equal(privateKey in mapRecord, false, privateKey);
    }
    assert.deepEqual(await fixture.repository.listPublicMapOffices({
        bbox: { westE1: 1215, southE1: 312, eastE1: 1215, northE1: 312 },
        city: 'Shanghai',
        seriesCode: '765',
        isOpen: true,
        limit: 20
    }).then((rows) => rows.map(({ id }) => id)), ['map-positive']);
    assert.deepEqual(await fixture.repository.listPublicMapOffices({
        bbox: { westE1: -456, southE1: -32, eastE1: -456, northE1: -32 },
        isOpen: false,
        limit: 20
    }).then((rows) => rows.map(({ id }) => id)), ['map-negative']);

    const pendingReviews = await fixture.repository.listOfficeLocationReviews({
        reviewState: 'pending',
        limit: 20
    });
    assert.deepEqual(pendingReviews.map(({ office_id }) => office_id), [
        'location-hidden',
        'map-pending'
    ]);
    assert.equal(pendingReviews[1]?.office_name, 'Office map-pending');
    assert.equal(pendingReviews[1]?.owner_account_id, ownerId);

    const core = new SqlCoreRepository(
        fixture.database,
        initializedPostgresSchema
    );
    assert.equal(await core.deleteAdminAccount(reviewerId), 'moderation-history');
    const reviewerTable = dialect === 'sqlite' ? 'users' : 'backoffice_accounts';
    assert.equal(await fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM ${reviewerTable} WHERE id=?`
    ).bind(reviewerId).first<number>('count'), 1);
}

test('real PostgreSQL enforces Fudaba location CAS and public map eligibility', {
    skip: !postgresIntegrationEnabled() &&
        'set IMS_TEST_POSTGRES_ADMIN_URL to a local PostgreSQL admin database'
}, async (t) => {
    await assertLocationRepository(t, 'postgresql');
});
