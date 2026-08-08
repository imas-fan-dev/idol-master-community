import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { SqlFudabaRepository } from '@/infra/db/repositories/fudaba-repository';
import type {
    ManagedSqlDatabase,
    SqlSchemaStrategy
} from '@/infra/db/sql/database';
import type {
    NewFudabaCardInput,
    NewFudabaOfficeInput,
    PlatformAccountStatus
} from '@/ports/repositories';
import {
    createPostgresTestHarness,
    postgresIntegrationEnabled
} from '../integration/postgres-harness';
import { seedCanonicalFudabaAgencies } from '../integration/fudaba-agency-fixture';

const CREATED_AT = '2026-08-03T00:00:00.000Z';
const UPDATED_AT = '2026-08-03T00:01:00.000Z';
const ARCHIVED_AT = '2026-08-03T00:02:00.000Z';

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
        intro: '',
        city: 'Shanghai',
        address: 'Private address',
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
        ...overrides
    };
}

function card(
    id: string,
    ownerAccountId: string,
    overrides: Partial<NewFudabaCardInput> = {}
): NewFudabaCardInput {
    return {
        id,
        ownerAccountId,
        producerName: `Producer ${ownerAccountId}`,
        displayName: `Card ${id}`,
        seriesCode: '765',
        favoriteIdol: 'Haruka',
        frontObjectKey: `community/fudaba/cards/${id}/front.webp`,
        backObjectKey: `community/fudaba/cards/${id}/back.webp`,
        accent: '#4f64dd',
        bio: '',
        tradeNote: '',
        available: true,
        sourceUrl: null,
        sourceLabel: null,
        sourceCredit: null,
        mediaRightsStatus: 'approved',
        publicationStatus: 'published',
        revision: 0,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
        deletedAt: null,
        ...overrides
    };
}

function placementInput(
    officeId: string,
    cardId: string,
    ownerAccountId: string,
    expectedRevision: number | null,
    updatedAt = CREATED_AT
) {
    return {
        officeId,
        cardId,
        ownerAccountId,
        positionX: 12.5,
        positionY: 87.25,
        rotation: -4.5,
        zIndex: 8,
        expectedRevision,
        updatedAt
    };
}

async function assertCardPlacementRepository(
    t: TestContext,
    dialect: Fixture['dialect']
): Promise<void> {
    const fixture = await createFixture(t, dialect);
    const ownerId = `${dialect}-placement-owner`;
    const otherId = `${dialect}-placement-other`;
    const officeId = `${dialect}-placement-office`;
    const cardId = `${dialect}-placement-card`;
    const removableCardId = `${dialect}-removable-card`;
    const closedRemovalCardId = `${dialect}-closed-removal-card`;
    const closedCreateCardId = `${dialect}-closed-create-card`;
    const closedOfficeId = `${dialect}-closed-office`;
    const restrictedOfficeId = `${dialect}-restricted-owner-office`;
    const restrictedOfficeOwnerId = `${dialect}-restricted-office-owner`;
    const suspendedOfficeId = `${dialect}-suspended-owner-office`;
    const suspendedOfficeOwnerId = `${dialect}-suspended-office-owner`;
    await seedAccount(fixture, ownerId);
    await seedAccount(fixture, otherId);
    await seedAccount(fixture, restrictedOfficeOwnerId, 'restricted');
    await seedAccount(fixture, suspendedOfficeOwnerId, 'suspended');
    await fixture.repository.createOffice(office(officeId, ownerId));
    await fixture.repository.createOffice(office(closedOfficeId, otherId, {
        isOpen: false
    }));
    await fixture.repository.createOffice(office(
        restrictedOfficeId,
        restrictedOfficeOwnerId
    ));
    await fixture.repository.createOffice(office(
        suspendedOfficeId,
        suspendedOfficeOwnerId
    ));
    await fixture.repository.createCard(card(cardId, ownerId));
    await fixture.repository.createCard(card(removableCardId, ownerId));
    await fixture.repository.createCard(card(closedRemovalCardId, ownerId));
    await fixture.repository.createCard(card(closedCreateCardId, ownerId));
    await fixture.repository.createCard(card(`${dialect}-other-card`, otherId));
    await fixture.repository.createCard(card(`${dialect}-pending-card`, ownerId, {
        publicationStatus: 'pending'
    }));
    await fixture.repository.createCard(card(`${dialect}-deleted-card`, ownerId, {
        publicationStatus: 'pending',
        mediaRightsStatus: 'unknown',
        updatedAt: UPDATED_AT,
        deletedAt: UPDATED_AT
    }));
    await fixture.repository.createCard(card(`${dialect}-disabled-card`, ownerId, {
        seriesCode: 'sidem'
    }));

    const created = await fixture.repository.saveCardPlacementForOwner(
        placementInput(officeId, cardId, ownerId, null)
    );
    assert.equal(created.status, 'saved');
    if (created.status !== 'saved') return;
    assert.equal(created.created, true);
    assert.deepEqual(created.placement, {
        office_id: officeId,
        card_id: cardId,
        pinned_at: CREATED_AT,
        position_x: 12.5,
        position_y: 87.25,
        rotation: -4.5,
        z_index: 8,
        revision: 0,
        updated_at: CREATED_AT
    });

    assert.deepEqual(
        await fixture.repository.saveCardPlacementForOwner(
            placementInput(officeId, cardId, ownerId, null)
        ),
        { status: 'conflict', revision: 0 }
    );
    assert.deepEqual(
        await fixture.repository.saveCardPlacementForOwner(
            placementInput(officeId, cardId, ownerId, 3, UPDATED_AT)
        ),
        { status: 'conflict', revision: 0 }
    );
    assert.deepEqual(
        await fixture.repository.saveCardPlacementForOwner(
            placementInput(officeId, cardId, otherId, 0, UPDATED_AT)
        ),
        { status: 'unavailable' }
    );
    assert.deepEqual(
        await fixture.repository.saveCardPlacementForOwner(
            placementInput(closedOfficeId, cardId, ownerId, null)
        ),
        { status: 'unavailable' }
    );
    assert.deepEqual(
        await fixture.repository.saveCardPlacementForOwner(
            placementInput(suspendedOfficeId, cardId, ownerId, null)
        ),
        { status: 'unavailable' }
    );
    const restrictedOwnerPlacement =
        await fixture.repository.saveCardPlacementForOwner(
            placementInput(restrictedOfficeId, cardId, ownerId, null)
        );
    assert.equal(restrictedOwnerPlacement.status, 'saved');

    const updated = await fixture.repository.saveCardPlacementForOwner({
        ...placementInput(officeId, cardId, ownerId, 0, UPDATED_AT),
        positionX: 100,
        positionY: 0,
        rotation: 12,
        zIndex: 999
    });
    assert.equal(updated.status, 'saved');
    if (updated.status !== 'saved') return;
    assert.equal(updated.created, false);
    assert.deepEqual(updated.placement, {
        office_id: officeId,
        card_id: cardId,
        pinned_at: CREATED_AT,
        position_x: 100,
        position_y: 0,
        rotation: 12,
        z_index: 999,
        revision: 1,
        updated_at: UPDATED_AT
    });

    const ownerView = await fixture.repository.findPublicOfficeBySlug(
        officeId,
        ownerId
    );
    const placedCard = ownerView?.cards.find(({ id }) => id === cardId);
    assert.ok(placedCard);
    assert.equal(placedCard.viewer_owned, true);
    assert.equal(placedCard.revision, 1);
    assert.equal(placedCard.updated_at, UPDATED_AT);
    assert.equal(
        (await fixture.repository.findPublicOfficeBySlug(officeId, otherId))
            ?.cards.find(({ id }) => id === cardId)?.viewer_owned,
        false
    );

    await fixture.database.prepare(
        'UPDATE agencies SET wiki_enabled=? WHERE code=?'
    ).bind(dialect === 'sqlite' ? 0 : false, 'sidem').run();
    for (const unavailable of [
        placementInput(officeId, `${dialect}-other-card`, ownerId, null),
        placementInput(officeId, `${dialect}-pending-card`, ownerId, null),
        placementInput(officeId, `${dialect}-deleted-card`, ownerId, null),
        placementInput(officeId, `${dialect}-disabled-card`, ownerId, null),
        placementInput(`${dialect}-missing-office`, cardId, ownerId, null)
    ]) {
        assert.deepEqual(
            await fixture.repository.saveCardPlacementForOwner(unavailable),
            { status: 'unavailable' }
        );
    }

    assert.deepEqual(await fixture.repository.removeCardPlacementForOwner({
        officeId,
        cardId,
        ownerAccountId: ownerId,
        expectedRevision: 0
    }), { status: 'conflict', revision: 1 });
    assert.deepEqual(await fixture.repository.removeCardPlacementForOwner({
        officeId,
        cardId,
        ownerAccountId: otherId,
        expectedRevision: 1
    }), { status: 'unavailable' });

    const exchange = await fixture.repository.createExchangeRequest({
        id: `${dialect}-placement-exchange`,
        officeId,
        requesterAccountId: otherId,
        recipientAccountId: ownerId,
        wantedCardId: cardId,
        offeredCardId: null,
        note: '',
        createdAt: UPDATED_AT
    });
    assert.ok(exchange);
    assert.deepEqual(await fixture.repository.removeCardPlacementForOwner({
        officeId,
        cardId,
        ownerAccountId: ownerId,
        expectedRevision: 0
    }), { status: 'conflict', revision: 1 });
    assert.deepEqual(await fixture.repository.removeCardPlacementForOwner({
        officeId,
        cardId,
        ownerAccountId: ownerId,
        expectedRevision: 1
    }), { status: 'in-use', revision: 1 });

    const removable = await fixture.repository.saveCardPlacementForOwner(
        placementInput(officeId, removableCardId, ownerId, null)
    );
    assert.equal(removable.status, 'saved');
    const closedRemoval = await fixture.repository.saveCardPlacementForOwner(
        placementInput(officeId, closedRemovalCardId, ownerId, null)
    );
    assert.equal(closedRemoval.status, 'saved');
    await fixture.database.prepare(
        'UPDATE fudaba_offices SET is_open=? WHERE id=?'
    ).bind(dialect === 'sqlite' ? 0 : false, officeId).run();
    assert.deepEqual(
        await fixture.repository.saveCardPlacementForOwner(
            placementInput(officeId, cardId, ownerId, 1, ARCHIVED_AT)
        ),
        { status: 'unavailable' }
    );
    assert.deepEqual(
        await fixture.repository.saveCardPlacementForOwner(
            placementInput(officeId, closedCreateCardId, ownerId, null, ARCHIVED_AT)
        ),
        { status: 'unavailable' }
    );
    assert.deepEqual(await fixture.repository.removeCardPlacementForOwner({
        officeId,
        cardId: closedRemovalCardId,
        ownerAccountId: ownerId,
        expectedRevision: 0
    }), { status: 'removed', revision: 1 });
    await fixture.database.prepare(
        'UPDATE fudaba_offices SET is_open=? WHERE id=?'
    ).bind(dialect === 'sqlite' ? 1 : true, officeId).run();
    assert.equal(await fixture.repository.updateOfficeStatusForOwner({
        officeId,
        ownerAccountId: ownerId,
        status: 'archived',
        archivedAt: ARCHIVED_AT,
        updatedAt: ARCHIVED_AT,
        expectedRevision: 0
    }), true);
    assert.deepEqual(
        await fixture.repository.saveCardPlacementForOwner(
            placementInput(officeId, removableCardId, ownerId, 0, ARCHIVED_AT)
        ),
        { status: 'unavailable' }
    );
    await fixture.database.prepare(
        `UPDATE fudaba_cards
         SET publication_status='hidden', revision=revision+1, updated_at=?
         WHERE id=?`
    ).bind(ARCHIVED_AT, removableCardId).run();
    assert.deepEqual(await fixture.repository.removeCardPlacementForOwner({
        officeId,
        cardId: removableCardId,
        ownerAccountId: ownerId,
        expectedRevision: 0
    }), { status: 'removed', revision: 1 });
    assert.equal(await fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM fudaba_office_cards
         WHERE office_id=? AND card_id=?`
    ).bind(officeId, removableCardId).first<number>('count'), 0);
}

test('real PostgreSQL enforces the same Fudaba card placement contract', {
    skip: !postgresIntegrationEnabled() &&
        'set IMS_TEST_POSTGRES_ADMIN_URL to a local PostgreSQL admin database'
}, async (t) => {
    await assertCardPlacementRepository(t, 'postgresql');
});
