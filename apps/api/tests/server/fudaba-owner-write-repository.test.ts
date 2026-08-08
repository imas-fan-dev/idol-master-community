import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { SqlFudabaRepository } from '@/infra/db/repositories/fudaba-repository';
import { SqlPlatformAccountRepository } from '@/infra/db/repositories/platform-account-repository';
import type {
    ManagedSqlDatabase,
    SqlSchemaStrategy
} from '@/infra/db/sql/database';
import type {
    CreateOwnedFudabaCardInput,
    NewFudabaCardInput,
    NewPlatformAccountInput,
    PlatformAccountStatus
} from '@/ports/repositories';
import {
    createPostgresTestHarness,
    postgresIntegrationEnabled
} from '../integration/postgres-harness';
import { seedCanonicalFudabaAgencies } from '../integration/fudaba-agency-fixture';

const CREATED_AT = '2026-08-02T03:00:00.000Z';
const UPDATED_AT = '2026-08-02T03:01:00.000Z';
const MEDIA_UPDATED_AT = '2026-08-02T03:02:00.000Z';
const DELETED_AT = '2026-08-02T03:03:00.000Z';
const PROFILE_CREATED_AT = 1_775_100_000_000;

const initializedPostgresSchema: SqlSchemaStrategy = {
    initializeCore: async () => undefined,
    initializePlatform: async () => undefined,
    initializeFudaba: async () => undefined,
    initializeStory: async () => undefined
};

interface Fixture {
    database: ManagedSqlDatabase;
    platform: SqlPlatformAccountRepository;
    fudaba: SqlFudabaRepository;
    dialect: 'sqlite' | 'postgresql';
}

async function createFixture(
    t: TestContext,
    dialect: Fixture['dialect']
): Promise<Fixture> {
    const harness = await createPostgresTestHarness();
    const platform = new SqlPlatformAccountRepository(
        harness.connection,
        initializedPostgresSchema
    );
    const fudaba = new SqlFudabaRepository(
        harness.connection,
        initializedPostgresSchema
    );
    t.after(() => harness.close());
    await Promise.all([platform.initialize(), fudaba.initialize()]);
    await seedCanonicalFudabaAgencies(harness.connection);
    return { database: harness.connection, platform, fudaba, dialect };
}

function account(
    id: string,
    status: PlatformAccountStatus = 'active',
    avatarObjectKey: string | null = null
): NewPlatformAccountInput {
    return {
        id,
        status,
        tokenVersion: 0,
        createdAt: PROFILE_CREATED_AT,
        updatedAt: PROFILE_CREATED_AT,
        deletedAt: status === 'deleted' ? PROFILE_CREATED_AT : null,
        profile: {
            displayName: `Producer ${id}`,
            avatarObjectKey,
            avatarExternalUrl: null,
            homeCity: null,
            bio: '',
            updatedAt: PROFILE_CREATED_AT
        }
    };
}

function ownedCard(
    id: string,
    ownerAccountId: string,
    seriesCode = '765'
): CreateOwnedFudabaCardInput {
    return {
        id,
        ownerAccountId,
        producerName: `Producer ${ownerAccountId}`,
        displayName: `Card ${id}`,
        seriesCode,
        favoriteIdol: 'Haruka',
        frontObjectKey: `community/fudaba/cards/${id}/front.webp`,
        backObjectKey: `community/fudaba/cards/${id}/back.webp`,
        accent: '#4f64dd',
        bio: 'Profile',
        tradeNote: 'Available for trade',
        available: true,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT
    };
}

function importedCard(
    id: string,
    ownerAccountId: string
): NewFudabaCardInput {
    return {
        ...ownedCard(id, ownerAccountId),
        sourceUrl: 'https://example.test/source',
        sourceLabel: 'Imported source',
        sourceCredit: 'Migration',
        mediaRightsStatus: 'approved',
        publicationStatus: 'published',
        revision: 0,
        deletedAt: null
    };
}

async function assertProfileWrites(fixture: Fixture): Promise<void> {
    const ownerId = `${fixture.dialect}-profile-owner`;
    const previousAvatar = `community/fudaba/accounts/${ownerId}/old-avatar.webp`;
    await fixture.platform.createAccountWithProfile(
        account(ownerId, 'active', previousAvatar)
    );

    const textSaved = await fixture.platform.updateProfileTextForOwner({
        accountId: ownerId,
        displayName: 'Updated Producer',
        homeCity: 'Shanghai',
        bio: 'Updated profile',
        expectedUpdatedAt: PROFILE_CREATED_AT,
        updatedAt: PROFILE_CREATED_AT + 1
    });
    assert.equal(textSaved.status, 'saved');
    if (textSaved.status !== 'saved') return;
    assert.equal(textSaved.previousAvatarObjectKey, previousAvatar);
    assert.equal(textSaved.profile.avatar_object_key, previousAvatar);
    assert.equal(textSaved.profile.display_name, 'Updated Producer');

    assert.deepEqual(await fixture.platform.updateProfileAvatarForOwner({
        accountId: ownerId,
        avatarObjectKey: 'unreachable-stale-avatar.webp',
        expectedUpdatedAt: PROFILE_CREATED_AT,
        updatedAt: PROFILE_CREATED_AT + 2
    }), {
        status: 'conflict',
        updatedAt: PROFILE_CREATED_AT + 1
    });

    const nextAvatar = `community/fudaba/accounts/${ownerId}/next-avatar.webp`;
    const avatarSaved = await fixture.platform.updateProfileAvatarForOwner({
        accountId: ownerId,
        avatarObjectKey: nextAvatar,
        expectedUpdatedAt: PROFILE_CREATED_AT + 1,
        updatedAt: PROFILE_CREATED_AT + 2
    });
    assert.equal(avatarSaved.status, 'saved');
    if (avatarSaved.status !== 'saved') return;
    assert.equal(avatarSaved.previousAvatarObjectKey, previousAvatar);
    assert.equal(avatarSaved.profile.avatar_object_key, nextAvatar);
    assert.equal(avatarSaved.profile.avatar_external_url, null);

    await fixture.database.prepare(
        "UPDATE platform_accounts SET status='restricted' WHERE id=?"
    ).bind(ownerId).run();
    assert.deepEqual(await fixture.platform.updateProfileTextForOwner({
        accountId: ownerId,
        displayName: 'Restricted update',
        homeCity: null,
        bio: '',
        expectedUpdatedAt: PROFILE_CREATED_AT + 2,
        updatedAt: PROFILE_CREATED_AT + 3
    }), { status: 'unavailable' });
    assert.equal(
        (await fixture.platform.findAccountWithProfileById(ownerId))?.profile.display_name,
        'Updated Producer'
    );
    assert.deepEqual(await fixture.platform.updateProfileAvatarForOwner({
        accountId: `${fixture.dialect}-missing-profile`,
        avatarObjectKey: null,
        expectedUpdatedAt: PROFILE_CREATED_AT,
        updatedAt: PROFILE_CREATED_AT + 1
    }), { status: 'unavailable' });
}

async function assertCardWrites(fixture: Fixture): Promise<void> {
    const ownerId = `${fixture.dialect}-card-owner`;
    const otherId = `${fixture.dialect}-card-other`;
    const restrictedId = `${fixture.dialect}-card-restricted`;
    await fixture.platform.createAccountWithProfile(account(ownerId));
    await fixture.platform.createAccountWithProfile(account(otherId));
    await fixture.platform.createAccountWithProfile(account(restrictedId, 'restricted'));

    assert.deepEqual(await fixture.fudaba.createCardForOwner(ownedCard(
        `${fixture.dialect}-restricted-card`,
        restrictedId
    )), { status: 'unavailable' });
    await fixture.database.prepare(
        "UPDATE agencies SET wiki_enabled=FALSE WHERE code='876'"
    ).run();
    assert.deepEqual(await fixture.fudaba.createCardForOwner(ownedCard(
        `${fixture.dialect}-disabled-series-card`,
        ownerId,
        '876'
    )), { status: 'unavailable' });

    const cardId = `${fixture.dialect}-owned-card`;
    const created = await fixture.fudaba.createCardForOwner(ownedCard(cardId, ownerId));
    assert.equal(created.status, 'saved');
    if (created.status !== 'saved') return;
    assert.equal(created.card.owner_account_id, ownerId);
    assert.equal(created.card.media_rights_status, 'unknown');
    assert.equal(created.card.publication_status, 'pending');
    assert.equal(created.card.revision, 0);
    assert.equal(created.card.source_url, null);

    const otherCardId = `${fixture.dialect}-other-card`;
    await fixture.fudaba.createCard(importedCard(otherCardId, otherId));
    assert.equal(await fixture.fudaba.findCardForOwner(cardId, otherId), null);
    assert.deepEqual(
        (await fixture.fudaba.listCardsForOwner(ownerId)).map((card) => card.id),
        [cardId]
    );

    assert.deepEqual(await fixture.fudaba.updateCardMetadataForOwner({
        cardId,
        ownerAccountId: otherId,
        producerName: 'Intruder',
        displayName: 'Intruder',
        seriesCode: '765',
        favoriteIdol: '',
        accent: '#ffffff',
        bio: '',
        tradeNote: '',
        available: false,
        expectedRevision: 0,
        updatedAt: UPDATED_AT
    }), { status: 'unavailable' });

    await fixture.database.prepare(
        `UPDATE fudaba_cards
         SET media_rights_status='approved', publication_status='published'
         WHERE id=?`
    ).bind(cardId).run();
    await fixture.database.prepare(
        "UPDATE agencies SET wiki_enabled=FALSE WHERE code='cg'"
    ).run();
    const metadataInput = {
        cardId,
        ownerAccountId: ownerId,
        producerName: 'Updated Producer',
        displayName: 'Updated Card',
        seriesCode: 'cg',
        favoriteIdol: 'Uzuki',
        accent: '#ef5b6c',
        bio: 'Updated bio',
        tradeNote: 'Updated note',
        available: false,
        expectedRevision: 0,
        updatedAt: UPDATED_AT
    } as const;
    assert.deepEqual(
        await fixture.fudaba.updateCardMetadataForOwner(metadataInput),
        { status: 'unavailable' }
    );
    await fixture.database.prepare(
        "UPDATE agencies SET wiki_enabled=TRUE WHERE code='cg'"
    ).run();

    const metadataSaved = await fixture.fudaba.updateCardMetadataForOwner(metadataInput);
    assert.equal(metadataSaved.status, 'saved');
    if (metadataSaved.status !== 'saved') return;
    assert.equal(metadataSaved.card.revision, 1);
    assert.equal(metadataSaved.card.series_code, 'cg');
    assert.equal(metadataSaved.card.media_rights_status, 'unknown');
    assert.equal(metadataSaved.card.publication_status, 'pending');
    assert.deepEqual(await fixture.fudaba.updateCardMetadataForOwner({
        ...metadataInput,
        displayName: 'Stale update',
        updatedAt: MEDIA_UPDATED_AT
    }), { status: 'conflict', revision: 1 });

    await fixture.database.prepare(
        `UPDATE fudaba_cards
         SET media_rights_status='approved', publication_status='published'
         WHERE id=?`
    ).bind(cardId).run();
    const nextFront = `community/fudaba/cards/${cardId}/front-next.webp`;
    const mediaSaved = await fixture.fudaba.updateCardMediaForOwner({
        cardId,
        ownerAccountId: ownerId,
        side: 'front',
        objectKey: nextFront,
        expectedRevision: 1,
        updatedAt: MEDIA_UPDATED_AT
    });
    assert.equal(mediaSaved.status, 'saved');
    if (mediaSaved.status !== 'saved') return;
    assert.equal(
        mediaSaved.previousObjectKey,
        ownedCard(cardId, ownerId).frontObjectKey
    );
    assert.equal(mediaSaved.card.front_object_key, nextFront);
    assert.equal(mediaSaved.card.revision, 2);
    assert.equal(mediaSaved.card.media_rights_status, 'unknown');
    assert.equal(mediaSaved.card.publication_status, 'pending');

    await fixture.database.prepare(
        "UPDATE platform_accounts SET status='restricted' WHERE id=?"
    ).bind(ownerId).run();
    assert.deepEqual(await fixture.fudaba.updateCardMediaForOwner({
        cardId,
        ownerAccountId: ownerId,
        side: 'back',
        objectKey: `community/fudaba/cards/${cardId}/back-blocked.webp`,
        expectedRevision: 2,
        updatedAt: DELETED_AT
    }), { status: 'unavailable' });
    await fixture.database.prepare(
        "UPDATE platform_accounts SET status='active' WHERE id=?"
    ).bind(ownerId).run();

    const deleted = await fixture.fudaba.softDeleteCardForOwner({
        cardId,
        ownerAccountId: ownerId,
        expectedRevision: 2,
        deletedAt: DELETED_AT
    });
    assert.equal(deleted.status, 'saved');
    if (deleted.status !== 'saved') return;
    assert.equal(deleted.card.deleted_at, DELETED_AT);
    assert.equal(deleted.card.revision, 3);
    assert.equal(await fixture.fudaba.findCardForOwner(cardId, ownerId), null);
    assert.deepEqual(await fixture.fudaba.listCardsForOwner(ownerId), []);
    assert.deepEqual(await fixture.fudaba.softDeleteCardForOwner({
        cardId,
        ownerAccountId: ownerId,
        expectedRevision: 3,
        deletedAt: DELETED_AT
    }), { status: 'unavailable' });
}

async function assertCrossInstanceCas(fixture: Fixture): Promise<void> {
    const siblingPlatform = new SqlPlatformAccountRepository(
        fixture.database,
        initializedPostgresSchema
    );
    const siblingFudaba = new SqlFudabaRepository(
        fixture.database,
        initializedPostgresSchema
    );
    await Promise.all([siblingPlatform.initialize(), siblingFudaba.initialize()]);

    const accountId = `${fixture.dialect}-cas-owner`;
    await fixture.platform.createAccountWithProfile(account(accountId));
    const profileResults = await Promise.all([
        fixture.platform.updateProfileTextForOwner({
            accountId,
            displayName: 'First writer',
            homeCity: null,
            bio: '',
            expectedUpdatedAt: PROFILE_CREATED_AT,
            updatedAt: PROFILE_CREATED_AT + 10
        }),
        siblingPlatform.updateProfileTextForOwner({
            accountId,
            displayName: 'Second writer',
            homeCity: null,
            bio: '',
            expectedUpdatedAt: PROFILE_CREATED_AT,
            updatedAt: PROFILE_CREATED_AT + 20
        })
    ]);
    assert.deepEqual(
        profileResults.map((result) => result.status).sort(),
        ['conflict', 'saved']
    );
    const savedProfile = profileResults.find((result) => result.status === 'saved');
    const profileConflict = profileResults.find((result) => result.status === 'conflict');
    assert.ok(savedProfile && savedProfile.status === 'saved');
    assert.ok(profileConflict && profileConflict.status === 'conflict');
    assert.equal(profileConflict.updatedAt, savedProfile.profile.updated_at);

    const cardId = `${fixture.dialect}-cas-card`;
    const created = await fixture.fudaba.createCardForOwner(ownedCard(cardId, accountId));
    assert.equal(created.status, 'saved');
    const baseUpdate = {
        cardId,
        ownerAccountId: accountId,
        producerName: 'CAS Producer',
        seriesCode: '765',
        favoriteIdol: '',
        accent: '#4f64dd',
        bio: '',
        tradeNote: '',
        available: true,
        expectedRevision: 0,
        updatedAt: UPDATED_AT
    } as const;
    const cardResults = await Promise.all([
        fixture.fudaba.updateCardMetadataForOwner({
            ...baseUpdate,
            displayName: 'First card writer'
        }),
        siblingFudaba.updateCardMetadataForOwner({
            ...baseUpdate,
            displayName: 'Second card writer'
        })
    ]);
    assert.deepEqual(
        cardResults.map((result) => result.status).sort(),
        ['conflict', 'saved']
    );
    const cardConflict = cardResults.find((result) => result.status === 'conflict');
    assert.ok(cardConflict && cardConflict.status === 'conflict');
    assert.equal(cardConflict.revision, 1);
}

test('real PostgreSQL enforces Stage 14 profile and card write fences', {
    skip: !postgresIntegrationEnabled() &&
        'set IMS_TEST_POSTGRES_ADMIN_URL to a local PostgreSQL admin database'
}, async (t) => {
    const fixture = await createFixture(t, 'postgresql');
    await assertProfileWrites(fixture);
    await assertCardWrites(fixture);
    await assertCrossInstanceCas(fixture);
});
