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

const OFFICE_CREATED_AT = '2026-08-02T00:00:00.000Z';
const OFFICE_UPDATED_AT = '2026-08-02T00:01:00.000Z';
const CARD_OLDEST_AT = '2026-08-02T01:00:00.000Z';
const CARD_OLD_AT = '2026-08-02T02:00:00.000Z';
const CARD_NEW_AT = '2026-08-02T03:00:00.000Z';
const CARD_DELETED_AT = '2026-08-02T04:00:00.000Z';

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

function office(
    id: string,
    overrides: Partial<NewFudabaOfficeInput> = {}
): NewFudabaOfficeInput {
    return {
        id,
        ownerAccountId: 'owner',
        slug: id,
        name: `Office ${id}`,
        intro: `Intro ${id}`,
        city: 'Shanghai',
        address: `Private address ${id}`,
        latitude: 31.2304,
        longitude: 121.4737,
        accent: '#ef5b6c',
        coverObjectKey: `community/fudaba/offices/${id}/cover.webp`,
        isOpen: true,
        visitorCount: 0,
        status: 'active',
        revision: 0,
        createdAt: OFFICE_CREATED_AT,
        updatedAt: OFFICE_CREATED_AT,
        archivedAt: null,
        seriesCodes: ['765'],
        ...overrides
    };
}

function card(
    id: string,
    overrides: Partial<NewFudabaCardInput> = {}
): NewFudabaCardInput {
    return {
        id,
        ownerAccountId: 'owner',
        producerName: `Producer ${id}`,
        displayName: `Card ${id}`,
        seriesCode: '765',
        favoriteIdol: 'Haruka',
        frontObjectKey: `community/fudaba/cards/${id}/front.webp`,
        backObjectKey: `community/fudaba/cards/${id}/back.webp`,
        accent: '#4f64dd',
        bio: `Bio ${id}`,
        tradeNote: `Trade ${id}`,
        available: true,
        sourceUrl: 'https://example.test/source',
        sourceLabel: 'Source',
        sourceCredit: 'Creator',
        mediaRightsStatus: 'approved',
        publicationStatus: 'published',
        revision: 0,
        createdAt: CARD_OLD_AT,
        updatedAt: CARD_OLD_AT,
        deletedAt: null,
        ...overrides
    };
}

async function seedAccount(
    fixture: Fixture,
    accountId: string,
    status: PlatformAccountStatus = 'active'
): Promise<void> {
    const createdAt = 1_700_000_000_000;
    await fixture.database.prepare(
        `INSERT INTO platform_accounts
            (id, status, token_version, created_at, updated_at, deleted_at)
         VALUES (?, ?, 0, ?, ?, ?)`
    ).bind(
        accountId,
        status,
        createdAt,
        createdAt,
        status === 'deleted' ? createdAt : null
    ).run();
}

async function placeCard(
    fixture: Fixture,
    officeId: string,
    cardId: string,
    zIndex: number,
    ownerAccountId = 'owner'
): Promise<void> {
    assert.equal(await fixture.repository.placeOwnedCard({
        officeId,
        cardId,
        ownerAccountId,
        pinnedAt: CARD_OLD_AT,
        positionX: 10 + zIndex,
        positionY: 20 + zIndex,
        rotation: zIndex,
        zIndex
    }), true);
}

function assertOfficePrivacy(record: Record<string, unknown>): void {
    for (const privateKey of [
        'owner_account_id',
        'address',
        'latitude',
        'longitude'
    ]) {
        assert.equal(privateKey in record, false, `${privateKey} must stay private`);
    }
}

async function assertPublicReadModels(
    t: TestContext,
    dialect: Fixture['dialect']
): Promise<void> {
    const fixture = await createFixture(t, dialect);
    for (const accountId of ['owner', 'viewer', 'other-viewer']) {
        await seedAccount(fixture, accountId);
    }
    await seedAccount(fixture, 'restricted-owner', 'restricted');
    await seedAccount(fixture, 'suspended-owner', 'suspended');
    await seedAccount(fixture, 'deleted-owner', 'deleted');

    await fixture.database.prepare(
        'UPDATE agencies SET wiki_enabled=? WHERE code=?'
    ).bind(
        dialect === 'sqlite' ? 0 : false,
        'sidem'
    ).run();

    await fixture.repository.createOffice(office('office-a-closed', {
        isOpen: false,
        visitorCount: 100,
        seriesCodes: ['765', 'cg']
    }));
    await fixture.repository.createOffice(office('office-b-open', {
        visitorCount: 100,
        seriesCodes: ['765', 'cg', 'sidem']
    }));
    await fixture.repository.createOffice(office('office-c-beijing', {
        city: 'Beijing',
        visitorCount: 50,
        seriesCodes: ['ml']
    }));
    await fixture.repository.createOffice(office('office-hidden', {
        status: 'hidden',
        visitorCount: 999,
        seriesCodes: ['cg']
    }));
    await fixture.repository.createOffice(office('office-archived', {
        status: 'archived',
        archivedAt: OFFICE_UPDATED_AT,
        updatedAt: OFFICE_UPDATED_AT,
        visitorCount: 998,
        seriesCodes: ['765']
    }));
    await fixture.repository.createOffice(office('office-d-restricted', {
        ownerAccountId: 'restricted-owner',
        visitorCount: 40
    }));
    await fixture.repository.createOffice(office('office-suspended-owner', {
        ownerAccountId: 'suspended-owner',
        visitorCount: 997
    }));
    await fixture.repository.createOffice(office('office-deleted-owner', {
        ownerAccountId: 'deleted-owner',
        visitorCount: 996
    }));

    const series = await fixture.repository.listPublicSeries();
    assert.equal(series.some((item) => item.code === 'sidem'), false);
    assert.deepEqual(
        series.slice(0, 3).map((item) => [item.code, item.active_office_count]),
        [
            ['765', 3],
            ['876', 0],
            ['cg', 2]
        ]
    );
    assert.deepEqual(series[0], {
        id: 1,
        code: '765',
        display_name: '765PRO',
        color: '#f34f6d',
        display_order: 0,
        icon_object_key: 'wiki/shared/static/icon/765pro.webp',
        image_transform: {
            fit: 'contain',
            focalX: 0.5,
            focalY: 0.5,
            zoom: 1,
            rotation: 0
        },
        active_office_count: 3
    });

    const firstOfficePage = await fixture.repository.listPublicOffices({
        limit: 1
    });
    assert.deepEqual(firstOfficePage.map((item) => item.id), ['office-a-closed']);
    assertOfficePrivacy(firstOfficePage[0] as unknown as Record<string, unknown>);
    assert.equal(firstOfficePage[0].cover_object_key?.endsWith('cover.webp'), true);
    const nextOfficePage = await fixture.repository.listPublicOffices({
        limit: 5,
        after: { visitorCount: 100, id: 'office-a-closed' }
    });
    assert.deepEqual(
        nextOfficePage.map((item) => item.id),
        ['office-b-open', 'office-c-beijing', 'office-d-restricted']
    );
    assert.deepEqual(await fixture.repository.listPublicOffices({
        city: 'Shanghai',
        seriesCode: 'cg',
        isOpen: true,
        limit: 10
    }).then((items) => items.map((item) => item.id)), ['office-b-open']);
    assert.deepEqual(await fixture.repository.listPublicOffices({
        isOpen: false,
        limit: 10
    }).then((items) => items.map((item) => item.id)), ['office-a-closed']);
    assert.deepEqual(await fixture.repository.listPublicOffices({
        seriesCode: 'sidem',
        limit: 10
    }), []);
    assert.deepEqual(await fixture.repository.listPublicOffices({
        city: 'Shang',
        limit: 10
    }), []);

    const cardInputs = [
        card('card-z-new', { createdAt: CARD_NEW_AT, updatedAt: CARD_NEW_AT }),
        card('card-y-new', { createdAt: CARD_NEW_AT, updatedAt: CARD_NEW_AT }),
        card('card-unavailable', {
            available: false,
            createdAt: CARD_OLD_AT,
            updatedAt: CARD_OLD_AT
        }),
        card('card-cinderella-old', {
            seriesCode: 'cg',
            createdAt: CARD_OLDEST_AT,
            updatedAt: CARD_OLDEST_AT
        }),
        card('card-hidden-office', {
            createdAt: CARD_OLDEST_AT,
            updatedAt: CARD_OLDEST_AT
        }),
        card('card-restricted-owner', {
            ownerAccountId: 'restricted-owner',
            createdAt: CARD_OLDEST_AT,
            updatedAt: CARD_OLDEST_AT
        }),
        card('card-suspended-owner', {
            ownerAccountId: 'suspended-owner',
            createdAt: CARD_OLDEST_AT,
            updatedAt: CARD_OLDEST_AT
        }),
        card('card-deleted-owner', {
            ownerAccountId: 'deleted-owner',
            createdAt: CARD_OLDEST_AT,
            updatedAt: CARD_OLDEST_AT
        }),
        card('card-disabled-series', {
            seriesCode: 'sidem',
            createdAt: CARD_OLDEST_AT,
            updatedAt: CARD_OLDEST_AT
        }),
        card('card-pending', {
            publicationStatus: 'pending',
            createdAt: CARD_NEW_AT,
            updatedAt: CARD_NEW_AT
        }),
        card('card-unapproved', {
            mediaRightsStatus: 'unknown',
            publicationStatus: 'pending',
            createdAt: CARD_NEW_AT,
            updatedAt: CARD_NEW_AT
        }),
        card('card-deleted', {
            createdAt: CARD_NEW_AT,
            updatedAt: CARD_NEW_AT
        })
    ];
    for (const input of cardInputs) {
        await fixture.repository.createCard(input);
    }
    await placeCard(fixture, 'office-b-open', 'card-y-new', 1);
    await placeCard(fixture, 'office-b-open', 'card-z-new', 2);
    await placeCard(fixture, 'office-b-open', 'card-unavailable', 3);
    await placeCard(fixture, 'office-b-open', 'card-pending', 4);
    await placeCard(fixture, 'office-b-open', 'card-unapproved', 5);
    await placeCard(fixture, 'office-b-open', 'card-deleted', 6);
    await placeCard(
        fixture,
        'office-b-open',
        'card-restricted-owner',
        7,
        'restricted-owner'
    );
    await placeCard(
        fixture,
        'office-b-open',
        'card-suspended-owner',
        8,
        'suspended-owner'
    );
    await placeCard(
        fixture,
        'office-b-open',
        'card-deleted-owner',
        9,
        'deleted-owner'
    );
    await placeCard(fixture, 'office-b-open', 'card-disabled-series', 10);
    await fixture.database.prepare(
        "UPDATE fudaba_offices SET status='active' WHERE id='office-hidden'"
    ).run();
    await placeCard(fixture, 'office-hidden', 'card-hidden-office', 1);
    await fixture.database.prepare(
        "UPDATE fudaba_offices SET status='hidden' WHERE id='office-hidden'"
    ).run();
    await placeCard(
        fixture,
        'office-suspended-owner',
        'card-hidden-office',
        1
    );
    await fixture.database.prepare(
        `UPDATE fudaba_cards
         SET deleted_at=?, updated_at=?, revision=revision+1
         WHERE id='card-deleted'`
    ).bind(CARD_DELETED_AT, CARD_DELETED_AT).run();

    for (const [kind, accountId] of [
        ['like', 'viewer'],
        ['like', 'other-viewer'],
        ['favorite', 'viewer']
    ] as const) {
        assert.equal(await fixture.repository.setCardInteraction({
            kind,
            cardId: 'card-z-new',
            accountId,
            active: true,
            createdAt: CARD_DELETED_AT
        }), true);
    }
    assert.equal(await fixture.repository.setCardInteraction({
        kind: 'favorite',
        cardId: 'card-y-new',
        accountId: 'other-viewer',
        active: true,
        createdAt: CARD_DELETED_AT
    }), true);

    const detail = await fixture.repository.findPublicOfficeBySlug(
        'office-b-open',
        'viewer'
    );
    assert.ok(detail);
    assertOfficePrivacy(detail as unknown as Record<string, unknown>);
    assert.deepEqual(detail.series_codes, ['765', 'cg']);
    assert.deepEqual(
        detail.cards.map((item) => item.id),
        [
            'card-y-new',
            'card-z-new',
            'card-unavailable',
            'card-restricted-owner'
        ]
    );
    assert.deepEqual(
        detail.cards.map((item) => item.z_index),
        [1, 2, 3, 7]
    );
    const likedCard = detail.cards.find((item) => item.id === 'card-z-new');
    assert.ok(likedCard);
    assert.equal(likedCard.like_count, 2);
    assert.equal(likedCard.favorite_count, 1);
    assert.equal(likedCard.viewer_liked, true);
    assert.equal(likedCard.viewer_favorited, true);
    assert.equal(likedCard.viewer_owned, false);
    assert.equal(likedCard.revision, 0);
    assert.equal(likedCard.updated_at, CARD_OLD_AT);
    assert.equal('owner_account_id' in likedCard, false);
    const ownerDetail = await fixture.repository.findPublicOfficeBySlug(
        'office-b-open',
        'owner'
    );
    assert.equal(
        ownerDetail?.cards.find((item) => item.id === 'card-z-new')?.viewer_owned,
        true
    );
    assert.equal(await fixture.repository.findPublicOfficeBySlug(
        'office-hidden',
        null
    ), null);
    assert.equal(await fixture.repository.findPublicOfficeBySlug(
        'office-suspended-owner',
        null
    ), null);
    assert.equal(await fixture.repository.findPublicOfficeBySlug(
        'office-deleted-owner',
        null
    ), null);
    const restrictedDetail = await fixture.repository.findPublicOfficeBySlug(
        'office-d-restricted',
        null
    );
    assert.ok(restrictedDetail);
    assertOfficePrivacy(restrictedDetail as unknown as Record<string, unknown>);

    const firstCardPage = await fixture.repository.listPublicCards({
        viewerAccountId: null,
        limit: 1
    });
    assert.deepEqual(firstCardPage.map((item) => item.id), ['card-z-new']);
    assert.equal(firstCardPage[0].viewer_liked, false);
    assert.equal(firstCardPage[0].viewer_favorited, false);
    assert.equal(firstCardPage[0].like_count, 2);
    assert.equal('owner_account_id' in firstCardPage[0], false);
    const allPublicCards = await fixture.repository.listPublicCards({
        viewerAccountId: null,
        limit: 100
    });
    assert.equal(
        allPublicCards.some((item) => item.id === 'card-restricted-owner'),
        true
    );
    for (const hiddenId of [
        'card-suspended-owner',
        'card-deleted-owner',
        'card-disabled-series',
        'card-pending',
        'card-unapproved',
        'card-deleted'
    ]) {
        assert.equal(
            allPublicCards.some((item) => item.id === hiddenId),
            false,
            hiddenId
        );
    }
    const nextCardPage = await fixture.repository.listPublicCards({
        viewerAccountId: 'viewer',
        limit: 2,
        after: { createdAt: CARD_NEW_AT, id: 'card-z-new' }
    });
    assert.deepEqual(
        nextCardPage.map((item) => item.id),
        ['card-y-new', 'card-unavailable']
    );
    assert.deepEqual(await fixture.repository.listPublicCards({
        seriesCode: '765',
        available: true,
        officeSlug: 'office-b-open',
        viewerAccountId: 'viewer',
        limit: 10,
        after: { createdAt: CARD_NEW_AT, id: 'card-z-new' }
    }).then((items) => items.map((item) => item.id)), [
        'card-y-new',
        'card-restricted-owner'
    ]);
    assert.deepEqual(await fixture.repository.listPublicCards({
        seriesCode: 'cg',
        viewerAccountId: null,
        limit: 10
    }).then((items) => items.map((item) => item.id)), ['card-cinderella-old']);
    assert.deepEqual(await fixture.repository.listPublicCards({
        seriesCode: 'sidem',
        viewerAccountId: null,
        limit: 10
    }), []);
    assert.deepEqual(await fixture.repository.listPublicCards({
        available: false,
        viewerAccountId: null,
        limit: 10
    }).then((items) => items.map((item) => item.id)), ['card-unavailable']);
    assert.deepEqual(await fixture.repository.listPublicCards({
        officeSlug: 'office-b-open',
        viewerAccountId: null,
        limit: 10
    }).then((items) => items.map((item) => item.id)), [
        'card-z-new',
        'card-y-new',
        'card-unavailable',
        'card-restricted-owner'
    ]);
    assert.deepEqual(await fixture.repository.listPublicCards({
        officeSlug: 'office-hidden',
        viewerAccountId: null,
        limit: 10
    }), []);
    assert.deepEqual(await fixture.repository.listPublicCards({
        officeSlug: 'office-suspended-owner',
        viewerAccountId: null,
        limit: 10
    }), []);
}

test('PostgreSQL exposes the same Fudaba public read models', {
    skip: !postgresIntegrationEnabled() &&
        'set IMS_TEST_POSTGRES_ADMIN_URL to a local PostgreSQL admin database'
}, async (t) => {
    await assertPublicReadModels(t, 'postgresql');
});
