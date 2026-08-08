'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
    applyMigrations,
    databaseUrl,
    parseArguments,
    readMigrations
} = require('../../scripts/migration/postgres-migrations');

test('released Platform and Fudaba migrations remain byte-for-byte immutable', () => {
    const expected = new Map([
        ['core/0011_platform_accounts.sql',
            '26f13cd59482e7d08c97262fc8aa0ec41a03b45a2479d59e3959ca3f10fbd8ad'],
        ['postgresql/0020_platform_accounts.sql',
            'b7a67b066fd49fa3191a3ecc9c05881a753ca8c83950056bc3ac63d0d9e9734f'],
        ['core/0013_fudaba_domain.sql',
            '54b28982af30f4513b9a860caab1462dd90679bf4f3714273bdbcfbba0804f95'],
        ['postgresql/0022_fudaba_domain.sql',
            '718e476b3db6828130a75fd4e10933c1ceac765ea203495ba0eb9320b78d905a'],
        ['core/0016_platform_email_verification.sql',
            'c3f2db65ec8c2ac514ed39e027c14164163a4cc8b64929855ae18a0c893c8938'],
        ['postgresql/0025_platform_email_verification.sql',
            '987e277a19c4637244737480a28eb8cc04d156039dfe4115855c1b879a6cf2bd']
    ]);
    for (const [relativePath, checksum] of expected) {
        const contents = fs.readFileSync(
            path.join(__dirname, '../../migrations', relativePath)
        );
        assert.equal(
            crypto.createHash('sha256').update(contents).digest('hex'),
            checksum,
            `${relativePath} changed after its release`
        );
    }
});

test('PostgreSQL migrations are ordered and split around the data import', () => {
    const migrations = readMigrations();
    assert.deepEqual(
        migrations.map(({ version, phase }) => ({ version, phase })),
        [
            { version: '0001_initial_compatibility', phase: 'pre-data' },
            { version: '0002_legacy_card_emojis_fk', phase: 'post-data' },
            { version: '0003_s3_object_lifecycle', phase: 'post-data' },
            { version: '0004_site_packages', phase: 'pre-data' },
            { version: '0005_site_package_publication_owner', phase: 'pre-data' },
            { version: '0006_s3_semantic_physical_keys', phase: 'post-data' },
            { version: '0007_wiki_catalog_metadata', phase: 'post-data' },
            { version: '0008_auth_refresh_sessions', phase: 'pre-data' },
            { version: '0009_s3_public_storage_scope', phase: 'post-data' },
            { version: '0010_admin_roles', phase: 'post-data' },
            { version: '0011_wiki_dynamic_catalog', phase: 'post-data' },
            { version: '0012_wiki_normalized_stories', phase: 'post-data' },
            { version: '0013_wiki_image_transforms', phase: 'post-data' },
            { version: '0014_wiki_story_source_catalogs', phase: 'post-data' },
            { version: '0015_wiki_story_cover_assets', phase: 'post-data' },
            { version: '0016_wiki_soft_deletion', phase: 'post-data' },
            { version: '0017_wiki_entry_types', phase: 'post-data' },
            { version: '0018_wiki_story_cover_presentation', phase: 'post-data' },
            { version: '0019_homepage_links', phase: 'post-data' },
            { version: '0020_platform_accounts', phase: 'pre-data' },
            { version: '0021_backoffice_persistence_names', phase: 'post-data' },
            { version: '0022_fudaba_domain', phase: 'post-data' },
            { version: '0023_fudaba_public_locations', phase: 'post-data' },
            { version: '0024_fudaba_office_workflows', phase: 'post-data' },
            { version: '0025_platform_email_verification', phase: 'post-data' },
            { version: '0026_platform_email_verification_delivery', phase: 'post-data' },
            { version: '0027_fudaba_agency_catalog', phase: 'post-data' },
            { version: '20260804095901_wiki_idol_url', phase: 'post-data' },
            {
                version: '20260805090000_wiki_story_content_type_icons',
                phase: 'post-data'
            }
        ]
    );
    for (const migration of migrations) assert.match(migration.checksum, /^[a-f0-9]{64}$/);
    const ownership = migrations.find(
        ({ version }) => version === '0005_site_package_publication_owner'
    );
    assert.match(ownership.sql, /UNIQUE \(package_id, id\)/);
    assert.match(ownership.sql, /FOREIGN KEY \(id, published_revision_id\)/);
    const catalog = migrations.find(
        ({ version }) => version === '0011_wiki_dynamic_catalog'
    );
    assert.match(catalog.sql, /DROP CONSTRAINT wiki_group_members_idol_id_key/);
    assert.match(catalog.sql, /UNIQUE \(agency_id, folder_name\)/);
    const stories = migrations.find(
        ({ version }) => version === '0012_wiki_normalized_stories'
    );
    assert.match(stories.sql, /CREATE TABLE public\.wiki_story_cards/);
    assert.match(stories.sql, /CREATE TABLE public\.wiki_story_links/);
    assert.match(stories.sql, /legacy_subtitle TEXT/);
    assert.match(stories.sql, /legacy_image_file TEXT/);
    assert.match(stories.sql, /legacy_projection EXCEPT SELECT \* FROM normalized_projection/);
    assert.match(stories.sql, /normalized_projection EXCEPT SELECT \* FROM legacy_projection/);
    assert.match(stories.sql, /GREATEST\([\s\S]+MAX\(legacy_id\)/);
    assert.doesNotMatch(stories.sql, /DROP TABLE public\.(?:"765_stories"|cg_stories)/);
    const imageTransforms = migrations.find(
        ({ version }) => version === '0013_wiki_image_transforms'
    );
    assert.match(imageTransforms.sql, /ALTER TABLE public\.wiki_story_cards/);
    assert.match(imageTransforms.sql, /ALTER COLUMN color DROP NOT NULL/);
    assert.match(imageTransforms.sql, /image_focal_x DOUBLE PRECISION/);
    assert.match(imageTransforms.sql, /icon_media_revision INTEGER/);
    const sourceCatalogs = migrations.find(
        ({ version }) => version === '0014_wiki_story_source_catalogs'
    );
    assert.match(sourceCatalogs.sql, /CREATE TABLE public\.wiki_story_content_types/);
    assert.match(sourceCatalogs.sql, /CREATE TABLE public\.wiki_story_source_platforms/);
    assert.match(sourceCatalogs.sql, /ADD COLUMN content_type_id BIGINT/);
    assert.match(sourceCatalogs.sql, /ADD COLUMN source_platform_id BIGINT/);
    assert.match(sourceCatalogs.sql, /ON DELETE RESTRICT/);
    const coverAssets = migrations.find(
        ({ version }) => version === '0015_wiki_story_cover_assets'
    );
    assert.match(coverAssets.sql, /CREATE TABLE public\.wiki_story_cover_assets/);
    assert.match(coverAssets.sql, /ADD COLUMN cover_asset_id BIGINT/);
    assert.match(coverAssets.sql, /cover_asset_id IS NULL OR image_file IS NULL/);
    assert.match(coverAssets.sql, /ON DELETE RESTRICT/);
    const softDeletion = migrations.find(
        ({ version }) => version === '0016_wiki_soft_deletion'
    );
    assert.match(softDeletion.sql, /ALTER TABLE public\.idols/);
    assert.match(softDeletion.sql, /ALTER TABLE public\.wiki_story_cards/);
    assert.match(softDeletion.sql, /ALTER TABLE public\.wiki_story_links/);
    assert.match(softDeletion.sql, /deleted_at TIMESTAMPTZ/);
    assert.match(softDeletion.sql, /WHERE deleted_at IS NULL/);
    const entryTypes = migrations.find(
        ({ version }) => version === '0017_wiki_entry_types'
    );
    assert.match(entryTypes.sql, /ADD COLUMN entry_kind TEXT/);
    assert.match(entryTypes.sql, /ADD COLUMN entry_subtype TEXT/);
    assert.match(entryTypes.sql, /groups\.code = 'sidem-units'/);
    assert.match(entryTypes.sql, /groups\.code = 'sidem-special'/);
    const coverPresentation = migrations.find(
        ({ version }) => version === '0018_wiki_story_cover_presentation'
    );
    assert.match(coverPresentation.sql, /ADD COLUMN presentation_policy TEXT/);
    assert.match(coverPresentation.sql, /presentation_policy IN \('inherit', 'contain'\)/);
    const homepageLinks = migrations.find(
        ({ version }) => version === '0019_homepage_links'
    );
    assert.match(homepageLinks.sql, /CREATE TABLE public\.homepage_links/);
    assert.match(homepageLinks.sql, /INSERT INTO public\.homepage_links/);
    assert.match(homepageLinks.sql, /'navigation-events'/);
    const platformAccounts = migrations.find(
        ({ version }) => version === '0020_platform_accounts'
    );
    for (const table of [
        'platform_accounts',
        'platform_profiles',
        'platform_oauth_providers',
        'platform_oauth_identities',
        'platform_oauth_states',
        'platform_refresh_sessions',
        'platform_email_credentials',
        'platform_security_events'
    ]) {
        assert.match(platformAccounts.sql, new RegExp(`CREATE TABLE public\\.${table}`));
    }
    assert.match(platformAccounts.sql, /status IN \('active', 'restricted', 'suspended', 'deleted'\)/);
    assert.match(platformAccounts.sql, /\('google', 'Google', TRUE\)/);
    assert.match(platformAccounts.sql, /\('github', 'GitHub', TRUE\)/);
    assert.match(platformAccounts.sql, /UNIQUE \(account_id, provider_code\)/);
    assert.match(platformAccounts.sql, /platform_refresh_sessions_account_idx/);
    assert.match(platformAccounts.sql, /algorithm IN \('pbkdf2-sha256', 'bcrypt'\)/);
    const backofficeNames = migrations.find(
        ({ version }) => version === '0021_backoffice_persistence_names'
    );
    assert.match(backofficeNames.sql, /ALTER TABLE public\.users RENAME TO backoffice_accounts/);
    assert.match(backofficeNames.sql, /RENAME COLUMN user_id TO account_id/);
    assert.match(backofficeNames.sql, /users_id_not_null TO backoffice_accounts_id_not_null/);
    assert.match(
        backofficeNames.sql,
        /auth_refresh_sessions_user_id_not_null[\s\S]+backoffice_refresh_sessions_account_id_not_null/
    );
    assert.match(backofficeNames.sql, /backoffice_refresh_sessions_account_idx/);
    assert.match(backofficeNames.sql, /CREATE VIEW public\.users AS/);
    assert.match(backofficeNames.sql, /CREATE VIEW public\.auth_refresh_sessions AS/);
    const fudabaDomain = migrations.find(
        ({ version }) => version === '0022_fudaba_domain'
    );
    for (const table of [
        'fudaba_offices',
        'fudaba_series_tags',
        'fudaba_office_series_tags',
        'fudaba_cards',
        'fudaba_office_cards',
        'fudaba_messages',
        'fudaba_exchange_requests',
        'fudaba_card_likes',
        'fudaba_card_favorites',
        'fudaba_moderation_cases'
    ]) {
        assert.match(fudabaDomain.sql, new RegExp(`CREATE TABLE public\\.${table}`));
    }
    for (const seriesCode of [
        '765as',
        'cinderella',
        'million-live',
        'sidem',
        'shiny-colors',
        'gakuen',
        'valiv'
    ]) {
        assert.match(fudabaDomain.sql, new RegExp(`\\('${seriesCode}',`));
    }
    assert.match(fudabaDomain.sql, /REFERENCES public\.platform_accounts\(id\)/);
    assert.match(fudabaDomain.sql, /REFERENCES public\.backoffice_accounts\(id\)/);
    assert.match(
        fudabaDomain.sql,
        /FOREIGN KEY \(wanted_card_id, recipient_account_id\)[\s\S]+REFERENCES public\.fudaba_cards\(id, owner_account_id\)/
    );
    assert.match(
        fudabaDomain.sql,
        /publication_status <> 'published' OR media_rights_status = 'approved'/
    );
    assert.match(fudabaDomain.sql, /CREATE UNIQUE INDEX fudaba_exchange_requests_pending_idx/);
    assert.match(fudabaDomain.sql, /CREATE FUNCTION public\.fudaba_require_active_office\(\)/);
    assert.match(fudabaDomain.sql, /CREATE FUNCTION public\.fudaba_validate_exchange_ownership\(\)/);
    assert.match(fudabaDomain.sql, /CREATE FUNCTION public\.fudaba_validate_exchange_transition\(\)/);
    assert.match(fudabaDomain.sql, /FUDABA_OFFICE_ARCHIVED/);
    assert.match(fudabaDomain.sql, /FUDABA_OFFERED_CARD_NOT_OWNED/);
    assert.match(fudabaDomain.sql, /FUDABA_EXCHANGE_INVALID_TRANSITION/);
    const publicLocations = migrations.find(
        ({ version }) => version === '0023_fudaba_public_locations'
    );
    assert.match(
        publicLocations.sql,
        /CREATE TABLE public\.fudaba_office_public_locations/
    );
    assert.match(
        publicLocations.sql,
        /office_id TEXT PRIMARY KEY[\s\S]+REFERENCES public\.fudaba_offices\(id\) ON DELETE CASCADE/
    );
    assert.match(publicLocations.sql, /latitude_e1 BETWEEN -600 AND 600/);
    assert.doesNotMatch(publicLocations.sql, /latitude_e1 BETWEEN -900 AND 900/);
    assert.match(publicLocations.sql, /longitude_e1 BETWEEN -1800 AND 1800/);
    assert.match(
        publicLocations.sql,
        /review_state IN \('pending', 'published', 'rejected'\)/
    );
    assert.match(
        publicLocations.sql,
        /REFERENCES public\.backoffice_accounts\(id\) ON DELETE RESTRICT/
    );
    assert.match(publicLocations.sql, /review_audit_id UUID UNIQUE/);
    assert.match(
        publicLocations.sql,
        /reviewed_at IS NULL OR reviewed_at >= submitted_at/
    );
    assert.match(
        publicLocations.sql,
        /review_state = 'pending'[\s\S]+reviewed_at IS NULL[\s\S]+reviewed_by IS NULL[\s\S]+review_audit_id IS NULL[\s\S]+review_note = ''/
    );
    assert.match(
        publicLocations.sql,
        /review_state IN \('published', 'rejected'\)[\s\S]+reviewed_at IS NOT NULL[\s\S]+reviewed_by IS NOT NULL[\s\S]+review_audit_id IS NOT NULL/
    );
    assert.match(publicLocations.sql, /length\(review_note\) <= 1000/);
    assert.match(
        publicLocations.sql,
        /review_state <> 'rejected'[\s\S]+length\(btrim\(review_note, E' \\t\\n\\v\\f\\r'\)\) BETWEEN 1 AND 1000/
    );
    assert.match(
        publicLocations.sql,
        /fudaba_office_public_locations_public_idx[\s\S]+latitude_e1, longitude_e1, office_id[\s\S]+WHERE review_state = 'published'/
    );
    assert.match(
        publicLocations.sql,
        /fudaba_office_public_locations_review_queue_idx[\s\S]+review_state, submitted_at, office_id[\s\S]+\);/
    );
    const reviewQueueIndex = publicLocations.sql.match(
        /CREATE INDEX fudaba_office_public_locations_review_queue_idx[\s\S]+?;/
    )?.[0];
    assert.ok(reviewQueueIndex);
    assert.doesNotMatch(reviewQueueIndex, /WHERE/);
    assert.match(
        publicLocations.sql,
        /fudaba_office_public_locations_reviewer_idx[\s\S]+reviewed_by, reviewed_at DESC, office_id[\s\S]+WHERE reviewed_by IS NOT NULL/
    );
    assert.match(
        publicLocations.sql,
        /CREATE TABLE public\.fudaba_rate_limit_windows \([\s\S]+bucket TEXT NOT NULL[\s\S]+key_hash TEXT NOT NULL[\s\S]+hits INTEGER NOT NULL[\s\S]+window_seconds INTEGER NOT NULL[\s\S]+reset_at BIGINT NOT NULL/
    );
    assert.match(
        publicLocations.sql,
        /length\(bucket\) BETWEEN 1 AND 128[\s\S]+length\(btrim\(bucket, E' \\t\\n\\v\\f\\r'\)\) = length\(bucket\)/
    );
    assert.match(publicLocations.sql, /key_hash ~ '\^\[0-9a-f\]\{64\}\$'/);
    assert.match(publicLocations.sql, /hits INTEGER NOT NULL CHECK \(hits > 0\)/);
    assert.match(
        publicLocations.sql,
        /window_seconds INTEGER NOT NULL CHECK \(window_seconds > 0\)/
    );
    assert.match(publicLocations.sql, /reset_at BIGINT NOT NULL CHECK \(reset_at > 0\)/);
    assert.match(publicLocations.sql, /PRIMARY KEY \(bucket, key_hash\)/);
    assert.match(
        publicLocations.sql,
        /CREATE INDEX fudaba_rate_limit_windows_reset_at_idx[\s\S]+fudaba_rate_limit_windows\(reset_at\)/
    );
    const officeWorkflows = migrations.find(
        ({ version }) => version === '0024_fudaba_office_workflows'
    );
    assert.match(
        officeWorkflows.sql,
        /ADD COLUMN pending_cover_object_key TEXT[\s\S]+pending_cover_submitted_at TIMESTAMPTZ/
    );
    assert.match(
        officeWorkflows.sql,
        /pending_cover_submitted_at >= created_at[\s\S]+pending_cover_object_key IS DISTINCT FROM cover_object_key/
    );
    assert.match(officeWorkflows.sql, /fudaba_offices_pending_cover_idx/);
    assert.match(
        officeWorkflows.sql,
        /ADD COLUMN revision INTEGER NOT NULL DEFAULT 0[\s\S]+ADD COLUMN updated_at TIMESTAMPTZ/
    );
    assert.match(
        officeWorkflows.sql,
        /UPDATE public\.fudaba_office_cards SET updated_at = pinned_at/
    );
    assert.match(
        officeWorkflows.sql,
        /fudaba_validate_placement_transition[\s\S]+NEW\.updated_at := COALESCE\(NEW\.updated_at, NEW\.pinned_at\)[\s\S]+FUDABA_PLACEMENT_STALE_UPDATE/
    );
    assert.match(
        officeWorkflows.sql,
        /hidden_by_account_id TEXT[\s\S]+REFERENCES public\.platform_accounts\(id\) ON DELETE RESTRICT/
    );
    assert.match(
        officeWorkflows.sql,
        /\(hidden_at IS NULL\) = \(hidden_by_account_id IS NULL\)/
    );
    assert.match(
        officeWorkflows.sql,
        /SELECT status INTO office_status[\s\S]+FOR NO KEY UPDATE[\s\S]+office_status IS DISTINCT FROM 'active'/
    );
    assert.match(
        officeWorkflows.sql,
        /CREATE TABLE public\.fudaba_geocoder_cache[\s\S]+PRIMARY KEY \(provider, query_hash\)/
    );
    assert.match(officeWorkflows.sql, /octet_length\(response_json\) BETWEEN 2 AND 65536/);
    assert.match(
        officeWorkflows.sql,
        /CREATE TABLE public\.fudaba_mutation_receipts[\s\S]+PRIMARY KEY \(scope, account_id, key_hash\)/
    );
    assert.match(officeWorkflows.sql, /request_hash ~ '\^\[0-9a-f\]\{64\}\$'/);
    assert.doesNotMatch(officeWorkflows.sql, /raw_(?:query|key|body)/i);
    const emailVerification = migrations.find(
        ({ version }) => version === '0025_platform_email_verification'
    );
    assert.match(
        emailVerification.sql,
        /CREATE TABLE public\.platform_email_verification_codes/
    );
    assert.match(
        emailVerification.sql,
        /normalized_email TEXT PRIMARY KEY[\s\S]+normalized_email = lower\(btrim\(normalized_email\)\)/
    );
    assert.match(
        emailVerification.sql,
        /code_hash TEXT NOT NULL CHECK \(code_hash ~ '\^\[a-f0-9\]\{64\}\$'\)/
    );
    assert.match(emailVerification.sql, /attempts_remaining BETWEEN 0 AND 5/);
    assert.match(
        emailVerification.sql,
        /consumed_token IS NULL OR consumed_token ~ '\^\[a-f0-9\]\{64\}\$'/
    );
    assert.match(emailVerification.sql, /CHECK \(expires_at > created_at\)/);
    assert.match(
        emailVerification.sql,
        /resend_after >= created_at AND resend_after <= expires_at/
    );
    assert.match(
        emailVerification.sql,
        /CREATE INDEX platform_email_verification_expiry_idx[\s\S]+platform_email_verification_codes\(expires_at\)/
    );
    const emailVerificationDelivery = migrations.find(
        ({ version }) => version === '0026_platform_email_verification_delivery'
    );
    assert.match(
        emailVerificationDelivery.sql,
        /ADD COLUMN pending_token TEXT[\s\S]+ADD COLUMN delivery_token TEXT/
    );
    assert.match(
        emailVerificationDelivery.sql,
        /platform_email_verification_pending_candidate_ck[\s\S]+pending_expires_at > pending_created_at/
    );
    assert.match(
        emailVerificationDelivery.sql,
        /delivery_token ~ '\^\[a-f0-9\]\{64\}\$'/
    );
    const fudabaAgencyCatalog = migrations.find(
        ({ version }) => version === '0027_fudaba_agency_catalog'
    );
    assert.match(
        fudabaAgencyCatalog.sql,
        /FUDABA_VALIV_AGENCY_RECONCILIATION_REQUIRED/
    );
    assert.match(
        fudabaAgencyCatalog.sql,
        /FUDABA_CANONICAL_AGENCY_MISSING/
    );
    for (const [sourceCode, agencyCode] of [
        ['765as', '765'],
        ['cinderella', 'cg'],
        ['million-live', 'ml'],
        ['sidem', 'sidem'],
        ['shiny-colors', 'sc'],
        ['gakuen', 'gk']
    ]) {
        assert.match(
            fudabaAgencyCatalog.sql,
            new RegExp(`WHEN '${sourceCode}' THEN '${agencyCode}'`)
        );
    }
    assert.doesNotMatch(
        fudabaAgencyCatalog.sql,
        /WHEN 'valiv' THEN '876'/
    );
    assert.match(
        fudabaAgencyCatalog.sql,
        /REFERENCES public\.agencies\(code\) ON DELETE RESTRICT/
    );
    assert.match(
        fudabaAgencyCatalog.sql,
        /DROP TABLE public\.fudaba_series_tags/
    );
    const idolWikiUrl = migrations.find(
        ({ version }) => version === '20260804095901_wiki_idol_url'
    );
    assert.match(idolWikiUrl.sql, /ADD COLUMN wiki_url TEXT/);
    assert.match(idolWikiUrl.sql, /idols_wiki_url_http_check/);
    assert.match(idolWikiUrl.sql, /length\(wiki_url\) BETWEEN 1 AND 2048/);
    assert.match(idolWikiUrl.sql, /wiki_url ~\* '\^https\?:\/\/'/);
    const storyContentTypeIcons = migrations.find(
        ({ version }) => version === '20260805090000_wiki_story_content_type_icons'
    );
    assert.match(storyContentTypeIcons.sql, /ADD COLUMN icon_name TEXT/);
    assert.match(storyContentTypeIcons.sql, /WHEN '剧情' THEN 'book-open-text'/);
    assert.match(storyContentTypeIcons.sql, /wiki_story_content_types_icon_name_check/);
});

test('PostgreSQL migration arguments require one PostgreSQL database URL', () => {
    assert.deepEqual(
        parseArguments(['--', '--migrations', '/tmp/migrations'], {
            DATABASE_URL: 'postgresql://imsweb:secret@localhost:5432/imsweb'
        }),
        {
            connectionString: 'postgresql://imsweb:secret@localhost:5432/imsweb',
            migrationsPath: '/tmp/migrations'
        }
    );
    assert.throws(() => databaseUrl({}), /DATABASE_URL is required/);
    assert.throws(() => databaseUrl({ DATABASE_URL: 'mysql://localhost/ims' }), /PostgreSQL URL/);
});

function migrationClient() {
    const rows = [];
    return {
        rows,
        async query(sql, values = []) {
            if (/SELECT version, filename, phase, checksum/.test(sql)) {
                return { rows: rows.map((row) => ({ ...row })) };
            }
            if (/INSERT INTO public\.ims_schema_migrations/.test(sql)) {
                rows.push({
                    version: values[0],
                    filename: values[1],
                    phase: values[2],
                    checksum: values[3]
                });
            }
            return { rows: [] };
        }
    };
}

test('PostgreSQL migration runner is repeatable and rejects checksum drift', async () => {
    const client = migrationClient();
    const migrations = readMigrations();
    const first = await applyMigrations(client, { migrations });
    assert.deepEqual(first.executed, [
        '0001_initial_compatibility',
        '0002_legacy_card_emojis_fk',
        '0003_s3_object_lifecycle',
        '0004_site_packages',
        '0005_site_package_publication_owner',
        '0006_s3_semantic_physical_keys',
        '0007_wiki_catalog_metadata',
        '0008_auth_refresh_sessions',
        '0009_s3_public_storage_scope',
        '0010_admin_roles',
        '0011_wiki_dynamic_catalog',
        '0012_wiki_normalized_stories',
        '0013_wiki_image_transforms',
        '0014_wiki_story_source_catalogs',
        '0015_wiki_story_cover_assets',
        '0016_wiki_soft_deletion',
        '0017_wiki_entry_types',
        '0018_wiki_story_cover_presentation',
        '0019_homepage_links',
        '0020_platform_accounts',
        '0021_backoffice_persistence_names',
        '0022_fudaba_domain',
        '0023_fudaba_public_locations',
        '0024_fudaba_office_workflows',
        '0025_platform_email_verification',
        '0026_platform_email_verification_delivery',
        '0027_fudaba_agency_catalog',
        '20260804095901_wiki_idol_url',
        '20260805090000_wiki_story_content_type_icons'
    ]);
    const second = await applyMigrations(client, { migrations });
    assert.deepEqual(second.executed, []);

    const drifted = migrations.map((migration, index) => index === 0
        ? { ...migration, checksum: '0'.repeat(64) }
        : migration
    );
    await assert.rejects(applyMigrations(client, { migrations: drifted }), /drifted/);
});
