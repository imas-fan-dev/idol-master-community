import type {
    AuditLogInput,
    CreateOwnedFudabaOfficeInput,
    CreateOwnedFudabaCardInput,
    FudabaCardPlacementRecord,
    FudabaCardPlacementRemovalResult,
    FudabaCardPlacementSaveResult,
    FudabaCardRecord,
    FudabaCardMutationResult,
    FudabaExchangeRequestRecord,
    FudabaModerationCaseRecord,
    FudabaOfficeLocationMutationResult,
    FudabaOfficeLocationReviewRecord,
    FudabaOfficeCreateResult,
    FudabaOfficeMutationResult,
    FudabaOfficePublicLocationRecord,
    FudabaOfficeRecord,
    FudabaOwnerOfficeRecord,
    FudabaPublicCardRecord,
    FudabaPublicOfficeDetailRecord,
    FudabaPublicMapOfficeRecord,
    FudabaPublicOfficeRecord,
    FudabaPublicPlacedCardRecord,
    FudabaPublicSeriesRecord,
    FudabaRepository,
    ListFudabaPublicCardsInput,
    ListFudabaPublicMapOfficesInput,
    ListFudabaPublicOfficesInput,
    NewFudabaCardInput,
    NewFudabaModerationCaseInput,
    NewFudabaOfficeInput,
    SoftDeleteOwnedFudabaCardInput,
    UpdateOwnedFudabaOfficeInput,
    UpdateOwnedFudabaCardMediaInput,
    UpdateOwnedFudabaCardMetadataInput
} from '@/ports/repositories';
import type {
    ManagedSqlDatabase,
    SqlSchemaStrategy
} from '@/infra/db/sql/database';
import {
    executeSql,
    queryAll,
    queryOne,
    sqlStatement
} from '@/infra/db/sql/query';

const OFFICE_COLUMNS = `id, owner_account_id, slug, name, intro, city, address,
    latitude, longitude, accent, cover_object_key, pending_cover_object_key,
    pending_cover_submitted_at, is_open, visitor_count, status, revision,
    created_at, updated_at, archived_at`;
const OWNER_OFFICE_COLUMNS = `office.id, office.owner_account_id, office.slug,
    office.name, office.intro, office.city, office.address, office.latitude,
    office.longitude, office.accent, office.cover_object_key,
    office.pending_cover_object_key, office.pending_cover_submitted_at,
    office.is_open, office.visitor_count, office.status, office.revision,
    office.created_at, office.updated_at, office.archived_at`;
const CARD_COLUMNS = `id, owner_account_id, producer_name, display_name,
    series_code, favorite_idol, front_object_key, back_object_key, accent, bio,
    trade_note, available, source_url, source_label, source_credit,
    media_rights_status, publication_status, revision, created_at, updated_at,
    deleted_at`;
const EXCHANGE_COLUMNS = `id, office_id, requester_account_id,
    recipient_account_id, wanted_card_id, offered_card_id, note, status,
    version, created_at, updated_at, resolved_at`;
const MODERATION_COLUMNS = `id, resource_kind, resource_id,
    reporter_account_id, reason, details, state, backoffice_actor_id,
    resolution, created_at, updated_at, resolved_at`;
const PUBLIC_OFFICE_COLUMNS = `office.id, office.slug, office.name, office.intro,
    office.city, office.accent, office.cover_object_key, office.is_open,
    office.visitor_count`;
const OFFICE_PUBLIC_LOCATION_COLUMNS = `office_id, latitude_e1, longitude_e1,
    review_state, revision, submitted_at, reviewed_at, reviewed_by, review_note`;
const QUALIFIED_OFFICE_PUBLIC_LOCATION_COLUMNS = `location.office_id,
    location.latitude_e1, location.longitude_e1, location.review_state,
    location.revision, location.submitted_at, location.reviewed_at,
    location.reviewed_by, location.review_note`;
const PUBLIC_MAP_OFFICE_COLUMNS = `office.id, office.slug, office.name,
    office.city, office.accent, office.is_open, location.latitude_e1,
    location.longitude_e1`;
const OFFICE_LOCATION_REVIEW_COLUMNS = `${QUALIFIED_OFFICE_PUBLIC_LOCATION_COLUMNS},
    office.name AS office_name, office.city AS office_city,
    office.owner_account_id`;
const PUBLIC_CARD_COLUMNS = `card.id, card.producer_name, card.display_name,
    card.series_code, card.favorite_idol, card.front_object_key,
    card.back_object_key, card.accent, card.bio, card.trade_note, card.available,
    card.source_url, card.source_label, card.source_credit, card.created_at,
    (SELECT COUNT(*) FROM fudaba_card_likes card_like
     WHERE card_like.card_id=card.id) AS like_count,
    (SELECT COUNT(*) FROM fudaba_card_favorites card_favorite
     WHERE card_favorite.card_id=card.id) AS favorite_count,
    EXISTS (
        SELECT 1 FROM fudaba_card_likes viewer_like
        WHERE viewer_like.card_id=card.id AND viewer_like.account_id=?
    ) AS viewer_liked,
    EXISTS (
        SELECT 1 FROM fudaba_card_favorites viewer_favorite
        WHERE viewer_favorite.card_id=card.id AND viewer_favorite.account_id=?
    ) AS viewer_favorited`;
const CARD_PLACEMENT_COLUMNS = `office_id, card_id, pinned_at, position_x,
    position_y, rotation, z_index, revision, updated_at`;
const PUBLIC_OFFICE_ELIGIBILITY = `office.status='active'
    AND office_owner.status IN ('active', 'restricted')
    AND office_owner.deleted_at IS NULL`;
const OPEN_OFFICE_CARD_WALL_ELIGIBILITY = `${PUBLIC_OFFICE_ELIGIBILITY}
    AND office.is_open`;
const PUBLIC_CARD_ELIGIBILITY = `card.publication_status='published'
    AND card.media_rights_status='approved' AND card.deleted_at IS NULL
    AND card_owner.status IN ('active', 'restricted')
    AND card_owner.deleted_at IS NULL`;

type TimestampValue = string | Date;

type FudabaOfficeRow = Omit<
    FudabaOfficeRecord,
    | 'is_open'
    | 'visitor_count'
    | 'revision'
    | 'created_at'
    | 'updated_at'
    | 'archived_at'
    | 'pending_cover_submitted_at'
> & {
    is_open: boolean | number | string;
    visitor_count: number | string;
    revision: number | string;
    created_at: TimestampValue;
    updated_at: TimestampValue;
    archived_at: TimestampValue | null;
    pending_cover_submitted_at: TimestampValue | null;
};

type FudabaCardRow = Omit<
    FudabaCardRecord,
    'available' | 'revision' | 'created_at' | 'updated_at' | 'deleted_at'
> & {
    available: boolean | number | string;
    revision: number | string;
    created_at: TimestampValue;
    updated_at: TimestampValue;
    deleted_at: TimestampValue | null;
};

type FudabaExchangeRequestRow = Omit<
    FudabaExchangeRequestRecord,
    'version' | 'created_at' | 'updated_at' | 'resolved_at'
> & {
    version: number | string;
    created_at: TimestampValue;
    updated_at: TimestampValue;
    resolved_at: TimestampValue | null;
};

type FudabaModerationCaseRow = Omit<
    FudabaModerationCaseRecord,
    'backoffice_actor_id' | 'created_at' | 'updated_at' | 'resolved_at'
> & {
    backoffice_actor_id: number | string | null;
    created_at: TimestampValue;
    updated_at: TimestampValue;
    resolved_at: TimestampValue | null;
};

type FudabaPublicSeriesRow = Omit<
    FudabaPublicSeriesRecord,
    'id' | 'display_order' | 'image_transform' | 'active_office_count'
> & {
    id: number | string;
    display_order: number | string;
    icon_fit: 'cover' | 'contain';
    icon_focal_x: number | string;
    icon_focal_y: number | string;
    icon_zoom: number | string;
    icon_rotation: 0 | 90 | 180 | 270 | string;
    active_office_count: number | string;
};

type FudabaPublicOfficeRow = Omit<
    FudabaPublicOfficeRecord,
    'is_open' | 'visitor_count' | 'series_codes'
> & {
    is_open: boolean | number | string;
    visitor_count: number | string;
};

type FudabaOfficeSeriesRow = {
    office_id: string;
    series_code: string;
};

type FudabaOwnerOfficeSeriesRow = FudabaOfficeRow & {
    series_code: string | null;
};

type FudabaMutationReceiptRow = {
    request_hash: string;
    resource_id: string;
};

type FudabaOfficePublicLocationRow = Omit<
    FudabaOfficePublicLocationRecord,
    | 'latitude_e1'
    | 'longitude_e1'
    | 'revision'
    | 'submitted_at'
    | 'reviewed_at'
    | 'reviewed_by'
> & {
    latitude_e1: number | string;
    longitude_e1: number | string;
    revision: number | string;
    submitted_at: TimestampValue;
    reviewed_at: TimestampValue | null;
    reviewed_by: number | string | null;
};

type FudabaPublicMapOfficeRow = Omit<
    FudabaPublicMapOfficeRecord,
    'is_open' | 'series_codes' | 'latitude_e1' | 'longitude_e1'
> & {
    is_open: boolean | number | string;
    latitude_e1: number | string;
    longitude_e1: number | string;
};

type FudabaOfficeLocationReviewRow = FudabaOfficePublicLocationRow & {
    office_name: string;
    office_city: string;
    owner_account_id: string;
};

type FudabaPublicCardRow = Omit<
    FudabaPublicCardRecord,
    | 'available'
    | 'created_at'
    | 'like_count'
    | 'favorite_count'
    | 'viewer_liked'
    | 'viewer_favorited'
> & {
    available: boolean | number | string;
    created_at: TimestampValue;
    like_count: number | string;
    favorite_count: number | string;
    viewer_liked: boolean | number | string;
    viewer_favorited: boolean | number | string;
};

type FudabaPublicPlacedCardRow = FudabaPublicCardRow & {
    pinned_at: TimestampValue;
    position_x: number | string;
    position_y: number | string;
    rotation: number | string;
    z_index: number | string;
    revision: number | string;
    updated_at: TimestampValue;
    viewer_owned: boolean | number | string;
};

type FudabaCardPlacementRow = Omit<
    FudabaCardPlacementRecord,
    | 'pinned_at'
    | 'position_x'
    | 'position_y'
    | 'rotation'
    | 'z_index'
    | 'revision'
    | 'updated_at'
> & {
    pinned_at: TimestampValue;
    position_x: number | string;
    position_y: number | string;
    rotation: number | string;
    z_index: number | string;
    revision: number | string;
    updated_at: TimestampValue;
};

function booleanValue(value: boolean | number | string): boolean {
    return value === true || value === 1 || value === '1' || value === 'true';
}

function timestampValue(value: TimestampValue): string {
    return value instanceof Date ? value.toISOString() : value;
}

function nullableTimestampValue(value: TimestampValue | null): string | null {
    return value === null ? null : timestampValue(value);
}

function officeRecord(row: FudabaOfficeRow): FudabaOfficeRecord {
    return {
        ...row,
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
        is_open: booleanValue(row.is_open),
        visitor_count: Number(row.visitor_count),
        revision: Number(row.revision),
        created_at: timestampValue(row.created_at),
        updated_at: timestampValue(row.updated_at),
        archived_at: nullableTimestampValue(row.archived_at),
        pending_cover_submitted_at: nullableTimestampValue(
            row.pending_cover_submitted_at
        )
    };
}

function cardRecord(row: FudabaCardRow): FudabaCardRecord {
    return {
        ...row,
        available: booleanValue(row.available),
        revision: Number(row.revision),
        created_at: timestampValue(row.created_at),
        updated_at: timestampValue(row.updated_at),
        deleted_at: nullableTimestampValue(row.deleted_at)
    };
}

function exchangeRecord(row: FudabaExchangeRequestRow): FudabaExchangeRequestRecord {
    return {
        ...row,
        version: Number(row.version),
        created_at: timestampValue(row.created_at),
        updated_at: timestampValue(row.updated_at),
        resolved_at: nullableTimestampValue(row.resolved_at)
    };
}

function moderationRecord(row: FudabaModerationCaseRow): FudabaModerationCaseRecord {
    return {
        ...row,
        backoffice_actor_id: row.backoffice_actor_id === null
            ? null
            : Number(row.backoffice_actor_id),
        created_at: timestampValue(row.created_at),
        updated_at: timestampValue(row.updated_at),
        resolved_at: nullableTimestampValue(row.resolved_at)
    };
}

function publicSeriesRecord(row: FudabaPublicSeriesRow): FudabaPublicSeriesRecord {
    return {
        id: Number(row.id),
        code: row.code,
        display_name: row.display_name,
        color: row.color,
        display_order: Number(row.display_order),
        icon_object_key: row.icon_object_key,
        image_transform: {
            fit: row.icon_fit,
            focalX: Number(row.icon_focal_x),
            focalY: Number(row.icon_focal_y),
            zoom: Number(row.icon_zoom),
            rotation: Number(row.icon_rotation) as 0 | 90 | 180 | 270
        },
        active_office_count: Number(row.active_office_count)
    };
}

function publicOfficeRecord(
    row: FudabaPublicOfficeRow,
    seriesCodes: string[]
): FudabaPublicOfficeRecord {
    return {
        id: row.id,
        slug: row.slug,
        name: row.name,
        intro: row.intro,
        city: row.city,
        accent: row.accent,
        cover_object_key: row.cover_object_key,
        is_open: booleanValue(row.is_open),
        visitor_count: Number(row.visitor_count),
        series_codes: seriesCodes
    };
}

function officePublicLocationRecord(
    row: FudabaOfficePublicLocationRow
): FudabaOfficePublicLocationRecord {
    return {
        ...row,
        latitude_e1: Number(row.latitude_e1),
        longitude_e1: Number(row.longitude_e1),
        revision: Number(row.revision),
        submitted_at: timestampValue(row.submitted_at),
        reviewed_at: nullableTimestampValue(row.reviewed_at),
        reviewed_by: row.reviewed_by === null ? null : Number(row.reviewed_by)
    };
}

function publicMapOfficeRecord(
    row: FudabaPublicMapOfficeRow,
    seriesCodes: string[]
): FudabaPublicMapOfficeRecord {
    return {
        id: row.id,
        slug: row.slug,
        name: row.name,
        city: row.city,
        accent: row.accent,
        is_open: booleanValue(row.is_open),
        series_codes: seriesCodes,
        latitude_e1: Number(row.latitude_e1),
        longitude_e1: Number(row.longitude_e1)
    };
}

function officeLocationReviewRecord(
    row: FudabaOfficeLocationReviewRow
): FudabaOfficeLocationReviewRecord {
    return {
        ...officePublicLocationRecord(row),
        office_name: row.office_name,
        office_city: row.office_city,
        owner_account_id: row.owner_account_id
    };
}

function publicCardRecord(row: FudabaPublicCardRow): FudabaPublicCardRecord {
    return {
        id: row.id,
        producer_name: row.producer_name,
        display_name: row.display_name,
        series_code: row.series_code,
        favorite_idol: row.favorite_idol,
        front_object_key: row.front_object_key,
        back_object_key: row.back_object_key,
        accent: row.accent,
        bio: row.bio,
        trade_note: row.trade_note,
        available: booleanValue(row.available),
        source_url: row.source_url,
        source_label: row.source_label,
        source_credit: row.source_credit,
        created_at: timestampValue(row.created_at),
        like_count: Number(row.like_count),
        favorite_count: Number(row.favorite_count),
        viewer_liked: booleanValue(row.viewer_liked),
        viewer_favorited: booleanValue(row.viewer_favorited)
    };
}

function publicPlacedCardRecord(
    row: FudabaPublicPlacedCardRow
): FudabaPublicPlacedCardRecord {
    return {
        ...publicCardRecord(row),
        pinned_at: timestampValue(row.pinned_at),
        position_x: Number(row.position_x),
        position_y: Number(row.position_y),
        rotation: Number(row.rotation),
        z_index: Number(row.z_index),
        revision: Number(row.revision),
        updated_at: timestampValue(row.updated_at),
        viewer_owned: booleanValue(row.viewer_owned)
    };
}

function cardPlacementRecord(
    row: FudabaCardPlacementRow
): FudabaCardPlacementRecord {
    return {
        office_id: row.office_id,
        card_id: row.card_id,
        pinned_at: timestampValue(row.pinned_at),
        position_x: Number(row.position_x),
        position_y: Number(row.position_y),
        rotation: Number(row.rotation),
        z_index: Number(row.z_index),
        revision: Number(row.revision),
        updated_at: timestampValue(row.updated_at)
    };
}

export class SqlFudabaRepository implements FudabaRepository {
    private initialized?: Promise<void>;
    private writeTail: Promise<void> = Promise.resolve();

    constructor(
        private readonly database: ManagedSqlDatabase,
        private readonly schema: SqlSchemaStrategy
    ) {}

    initialize(): Promise<void> {
        this.initialized ??= this.schema.initializeFudaba(this.database);
        return this.initialized;
    }

    close(): Promise<void> {
        return this.database.close();
    }

    private serializeWrite<Value>(operation: () => Promise<Value>): Promise<Value> {
        const result = this.writeTail.then(operation, operation);
        this.writeTail = result.then(() => undefined, () => undefined);
        return result;
    }

    private bindBoolean(value: boolean): boolean {
        return value;
    }

    private async attachOfficeSeries(
        rows: FudabaPublicOfficeRow[]
    ): Promise<FudabaPublicOfficeRecord[]> {
        if (rows.length === 0) return [];
        const seriesByOffice = new Map<string, string[]>(
            rows.map((row) => [row.id, []])
        );
        const placeholders = rows.map(() => '?').join(', ');
        const seriesRows = await queryAll<FudabaOfficeSeriesRow>(
            this.database,
            `SELECT office_id, series_code
             FROM fudaba_office_series_tags office_series
             JOIN agencies series
               ON series.code=office_series.series_code AND series.wiki_enabled
             WHERE office_id IN (${placeholders})
             ORDER BY office_id, office_series.display_order, series_code`,
            rows.map((row) => row.id)
        );
        for (const series of seriesRows) {
            seriesByOffice.get(series.office_id)?.push(series.series_code);
        }
        return rows.map((row) => publicOfficeRecord(
            row,
            seriesByOffice.get(row.id) ?? []
        ));
    }

    private ownerOfficesFromJoinedRows(
        rows: FudabaOwnerOfficeSeriesRow[]
    ): FudabaOwnerOfficeRecord[] {
        const offices = new Map<string, FudabaOwnerOfficeRecord>();
        for (const row of rows) {
            let office = offices.get(row.id);
            if (!office) {
                office = { ...officeRecord(row), series_codes: [] };
                offices.set(row.id, office);
            }
            if (row.series_code !== null) office.series_codes.push(row.series_code);
        }
        return [...offices.values()];
    }

    private async enabledOfficeSeriesAvailable(seriesCodes: string[]): Promise<boolean> {
        if (seriesCodes.length === 0) return false;
        const placeholders = seriesCodes.map(() => '?').join(', ');
        const row = await queryOne<{ count: number | string }>(
            this.database,
            `SELECT COUNT(*) AS count FROM agencies
             WHERE wiki_enabled=? AND code IN (${placeholders})`,
            [this.bindBoolean(true), ...seriesCodes]
        );
        return Number(row?.count ?? 0) === seriesCodes.length;
    }

    private findMutationReceipt(
        scope: string,
        accountId: string,
        keyHash: string
    ): Promise<FudabaMutationReceiptRow | null> {
        return queryOne<FudabaMutationReceiptRow>(
            this.database,
            `SELECT request_hash, resource_id FROM fudaba_mutation_receipts
             WHERE scope=? AND account_id=? AND key_hash=?`,
            [scope, accountId, keyHash]
        );
    }

    private async officeMutationFailure(
        officeId: string,
        ownerAccountId: string,
        expectedRevision: number,
        stateAllowed?: (office: FudabaOwnerOfficeRecord) => boolean,
        rejectPending = false
    ): Promise<FudabaOfficeMutationResult> {
        const current = await this.findOfficeForOwner(officeId, ownerAccountId);
        if (!current) return { status: 'unavailable' };
        if (current.revision !== expectedRevision) {
            return { status: 'conflict', revision: current.revision };
        }
        if (stateAllowed && !stateAllowed(current)) {
            return {
                status: 'state-conflict',
                revision: current.revision,
                officeStatus: current.status
            };
        }
        if (rejectPending && current.pending_cover_object_key) {
            return { status: 'pending-exists', revision: current.revision };
        }
        return { status: 'unavailable' };
    }

    private async attachMapOfficeSeries(
        rows: FudabaPublicMapOfficeRow[]
    ): Promise<FudabaPublicMapOfficeRecord[]> {
        if (rows.length === 0) return [];
        const seriesByOffice = new Map<string, string[]>(
            rows.map((row) => [row.id, []])
        );
        const placeholders = rows.map(() => '?').join(', ');
        const seriesRows = await queryAll<FudabaOfficeSeriesRow>(
            this.database,
            `SELECT office_id, series_code
             FROM fudaba_office_series_tags office_series
             JOIN agencies series
               ON series.code=office_series.series_code AND series.wiki_enabled
             WHERE office_id IN (${placeholders})
             ORDER BY office_id, office_series.display_order, series_code`,
            rows.map((row) => row.id)
        );
        for (const series of seriesRows) {
            seriesByOffice.get(series.office_id)?.push(series.series_code);
        }
        return rows.map((row) => publicMapOfficeRecord(
            row,
            seriesByOffice.get(row.id) ?? []
        ));
    }

    async listPublicSeries(): Promise<FudabaPublicSeriesRecord[]> {
        const rows = await queryAll<FudabaPublicSeriesRow>(
            this.database,
            `SELECT series.id, series.code, series.name_cn AS display_name,
                    series.color, series.display_order, series.icon_object_key,
                    series.icon_fit, series.icon_focal_x, series.icon_focal_y,
                    series.icon_zoom, series.icon_rotation,
                    COUNT(office_owner.id) AS active_office_count
             FROM agencies series
             LEFT JOIN fudaba_office_series_tags office_series
               ON office_series.series_code=series.code
             LEFT JOIN fudaba_offices office
               ON office.id=office_series.office_id AND office.status='active'
             LEFT JOIN platform_accounts office_owner
               ON office_owner.id=office.owner_account_id
              AND office_owner.status IN ('active', 'restricted')
              AND office_owner.deleted_at IS NULL
             WHERE series.wiki_enabled=?
             GROUP BY series.id, series.code, series.name_cn, series.color,
                      series.display_order, series.icon_object_key,
                      series.icon_fit, series.icon_focal_x, series.icon_focal_y,
                      series.icon_zoom, series.icon_rotation
             ORDER BY series.display_order, series.code`,
            [this.bindBoolean(true)]
        );
        return rows.map(publicSeriesRecord);
    }

    async listPublicOffices(
        input: ListFudabaPublicOfficesInput
    ): Promise<FudabaPublicOfficeRecord[]> {
        const conditions = [PUBLIC_OFFICE_ELIGIBILITY];
        const parameters: unknown[] = [];
        if (input.city !== undefined) {
            conditions.push('office.city=?');
            parameters.push(input.city);
        }
        if (input.seriesCode !== undefined) {
            conditions.push(`EXISTS (
                SELECT 1 FROM fudaba_office_series_tags series_filter
                JOIN agencies series
                  ON series.code=series_filter.series_code AND series.wiki_enabled
                WHERE series_filter.office_id=office.id
                  AND series_filter.series_code=?
            )`);
            parameters.push(input.seriesCode);
        }
        if (input.isOpen !== undefined) {
            conditions.push('office.is_open=?');
            parameters.push(this.bindBoolean(input.isOpen));
        }
        if (input.after) {
            conditions.push(`(
                office.visitor_count<? OR (
                    office.visitor_count=? AND office.id>?
                )
            )`);
            parameters.push(
                input.after.visitorCount,
                input.after.visitorCount,
                input.after.id
            );
        }
        parameters.push(input.limit);
        const rows = await queryAll<FudabaPublicOfficeRow>(
            this.database,
            `SELECT ${PUBLIC_OFFICE_COLUMNS}
             FROM fudaba_offices office
             JOIN platform_accounts office_owner
               ON office_owner.id=office.owner_account_id
             WHERE ${conditions.join(' AND ')}
             ORDER BY office.visitor_count DESC, office.id ASC
             LIMIT ?`,
            parameters
        );
        return this.attachOfficeSeries(rows);
    }

    async listPublicMapOffices(
        input: ListFudabaPublicMapOfficesInput
    ): Promise<FudabaPublicMapOfficeRecord[]> {
        const conditions = [
            `location.review_state='published'`,
            PUBLIC_OFFICE_ELIGIBILITY,
            `EXISTS (
                SELECT 1 FROM fudaba_office_series_tags eligible_office_series
                JOIN agencies eligible_series
                  ON eligible_series.code=eligible_office_series.series_code
                 AND eligible_series.wiki_enabled
                WHERE eligible_office_series.office_id=office.id
            )`
        ];
        const parameters: unknown[] = [];
        conditions.push(
            'location.longitude_e1>=?',
            'location.longitude_e1<=?',
            'location.latitude_e1>=?',
            'location.latitude_e1<=?'
        );
        parameters.push(
            input.bbox.westE1,
            input.bbox.eastE1,
            input.bbox.southE1,
            input.bbox.northE1
        );
        if (input.city !== undefined) {
            conditions.push('office.city=?');
            parameters.push(input.city);
        }
        if (input.seriesCode !== undefined) {
            conditions.push(`EXISTS (
                SELECT 1 FROM fudaba_office_series_tags map_series_filter
                JOIN agencies map_series
                  ON map_series.code=map_series_filter.series_code
                 AND map_series.wiki_enabled
                WHERE map_series_filter.office_id=office.id
                  AND map_series_filter.series_code=?
            )`);
            parameters.push(input.seriesCode);
        }
        if (input.isOpen !== undefined) {
            conditions.push('office.is_open=?');
            parameters.push(this.bindBoolean(input.isOpen));
        }
        parameters.push(input.limit);
        const rows = await queryAll<FudabaPublicMapOfficeRow>(
            this.database,
            `SELECT ${PUBLIC_MAP_OFFICE_COLUMNS}
             FROM fudaba_office_public_locations location
             JOIN fudaba_offices office ON office.id=location.office_id
             JOIN platform_accounts office_owner
               ON office_owner.id=office.owner_account_id
             WHERE ${conditions.join(' AND ')}
             ORDER BY location.latitude_e1 ASC,
                      location.longitude_e1 ASC, office.id ASC
             LIMIT ?`,
            parameters
        );
        return this.attachMapOfficeSeries(rows);
    }

    async findPublicOfficeBySlug(
        slug: string,
        viewerAccountId: string | null
    ): Promise<FudabaPublicOfficeDetailRecord | null> {
        const row = await queryOne<FudabaPublicOfficeRow>(
            this.database,
            `SELECT ${PUBLIC_OFFICE_COLUMNS}
             FROM fudaba_offices office
             JOIN platform_accounts office_owner
               ON office_owner.id=office.owner_account_id
             WHERE office.slug=? AND ${PUBLIC_OFFICE_ELIGIBILITY}`,
            [slug]
        );
        if (!row) return null;
        const [office] = await this.attachOfficeSeries([row]);
        const cardRows = await queryAll<FudabaPublicPlacedCardRow>(
            this.database,
            `SELECT ${PUBLIC_CARD_COLUMNS}, placement.pinned_at,
                    placement.position_x, placement.position_y,
                    placement.rotation, placement.z_index,
                    placement.revision, placement.updated_at,
                    COALESCE(card.owner_account_id=?, FALSE) AS viewer_owned
             FROM fudaba_office_cards placement
             JOIN fudaba_cards card ON card.id=placement.card_id
             JOIN platform_accounts card_owner
               ON card_owner.id=card.owner_account_id
             JOIN agencies card_series
               ON card_series.code=card.series_code AND card_series.wiki_enabled
             WHERE placement.office_id=? AND ${PUBLIC_CARD_ELIGIBILITY}
             ORDER BY placement.z_index ASC, placement.pinned_at ASC, card.id ASC`,
            [viewerAccountId, viewerAccountId, viewerAccountId, row.id]
        );
        return {
            ...office,
            cards: cardRows.map(publicPlacedCardRecord)
        };
    }

    async listPublicCards(
        input: ListFudabaPublicCardsInput
    ): Promise<FudabaPublicCardRecord[]> {
        const conditions = [PUBLIC_CARD_ELIGIBILITY];
        const parameters: unknown[] = [
            input.viewerAccountId,
            input.viewerAccountId
        ];
        if (input.seriesCode !== undefined) {
            conditions.push('card.series_code=?');
            parameters.push(input.seriesCode);
        }
        if (input.available !== undefined) {
            conditions.push('card.available=?');
            parameters.push(this.bindBoolean(input.available));
        }
        if (input.officeSlug !== undefined) {
            conditions.push(`EXISTS (
                SELECT 1 FROM fudaba_office_cards office_card
                JOIN fudaba_offices office ON office.id=office_card.office_id
                JOIN platform_accounts office_filter_owner
                  ON office_filter_owner.id=office.owner_account_id
                WHERE office_card.card_id=card.id AND office.slug=?
                  AND office.status='active'
                  AND office_filter_owner.status IN ('active', 'restricted')
                  AND office_filter_owner.deleted_at IS NULL
            )`);
            parameters.push(input.officeSlug);
        }
        if (input.after) {
            conditions.push(`(
                card.created_at<? OR (
                    card.created_at=? AND card.id<?
                )
            )`);
            parameters.push(
                input.after.createdAt,
                input.after.createdAt,
                input.after.id
            );
        }
        parameters.push(input.limit);
        const rows = await queryAll<FudabaPublicCardRow>(
            this.database,
            `SELECT ${PUBLIC_CARD_COLUMNS}
             FROM fudaba_cards card
             JOIN platform_accounts card_owner
               ON card_owner.id=card.owner_account_id
             JOIN agencies card_series
               ON card_series.code=card.series_code AND card_series.wiki_enabled
             WHERE ${conditions.join(' AND ')}
             ORDER BY card.created_at DESC, card.id DESC
             LIMIT ?`,
            parameters
        );
        return rows.map(publicCardRecord);
    }

    createOffice(input: NewFudabaOfficeInput): Promise<FudabaOfficeRecord> {
        return this.serializeWrite(async () => {
            const statements = [
                sqlStatement(
                    this.database,
                    `INSERT INTO fudaba_offices
                        (id, owner_account_id, slug, name, intro, city, address,
                         latitude, longitude, accent, cover_object_key, is_open,
                         visitor_count, status, revision, created_at, updated_at,
                         archived_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        input.id,
                        input.ownerAccountId,
                        input.slug,
                        input.name,
                        input.intro,
                        input.city,
                        input.address,
                        input.latitude,
                        input.longitude,
                        input.accent,
                        input.coverObjectKey,
                        this.bindBoolean(input.isOpen),
                        input.visitorCount,
                        input.status,
                        input.revision,
                        input.createdAt,
                        input.updatedAt,
                        input.archivedAt
                    ]
                ),
                ...input.seriesCodes.map((seriesCode, displayOrder) => sqlStatement(
                    this.database,
                    `INSERT INTO fudaba_office_series_tags
                        (office_id, series_code, display_order)
                     VALUES (?, ?, ?)`,
                    [input.id, seriesCode, displayOrder]
                ))
            ];
            await this.database.batch(statements);
            const created = await this.findOfficeById(input.id);
            if (!created) throw new Error('Fudaba office was not created');
            return created;
        });
    }

    async findOfficeById(id: string): Promise<FudabaOfficeRecord | null> {
        const row = await queryOne<FudabaOfficeRow>(
            this.database,
            `SELECT ${OFFICE_COLUMNS} FROM fudaba_offices WHERE id=?`,
            [id]
        );
        return row ? officeRecord(row) : null;
    }

    async listOfficesForOwner(
        ownerAccountId: string
    ): Promise<FudabaOwnerOfficeRecord[]> {
        const rows = await queryAll<FudabaOwnerOfficeSeriesRow>(
            this.database,
            `SELECT ${OWNER_OFFICE_COLUMNS}, office_series.series_code
             FROM fudaba_offices office
             LEFT JOIN fudaba_office_series_tags office_series
               ON office_series.office_id=office.id
             WHERE office.owner_account_id=?
             ORDER BY CASE office.status WHEN 'archived' THEN 1 ELSE 0 END,
                      office.updated_at DESC, office.id ASC,
                      office_series.display_order, office_series.series_code`,
            [ownerAccountId]
        );
        return this.ownerOfficesFromJoinedRows(rows);
    }

    async findOfficeForOwner(
        officeId: string,
        ownerAccountId: string
    ): Promise<FudabaOwnerOfficeRecord | null> {
        const rows = await queryAll<FudabaOwnerOfficeSeriesRow>(
            this.database,
            `SELECT ${OWNER_OFFICE_COLUMNS}, office_series.series_code
             FROM fudaba_offices office
             LEFT JOIN fudaba_office_series_tags office_series
               ON office_series.office_id=office.id
             WHERE office.id=? AND office.owner_account_id=?
             ORDER BY office_series.display_order, office_series.series_code`,
            [officeId, ownerAccountId]
        );
        return this.ownerOfficesFromJoinedRows(rows)[0] ?? null;
    }

    createOfficeForOwner(
        input: CreateOwnedFudabaOfficeInput
    ): Promise<FudabaOfficeCreateResult> {
        return this.serializeWrite(async () => {
            const ownerAccountLockClause = ' FOR UPDATE';
            const statements = [
                sqlStatement(
                    this.database,
                    `SELECT account.id FROM platform_accounts account
                     WHERE account.id=? AND account.status='active'
                       AND account.deleted_at IS NULL${ownerAccountLockClause}`,
                    [input.ownerAccountId]
                ),
                sqlStatement(
                    this.database,
                    `INSERT INTO fudaba_mutation_receipts
                        (scope, account_id, key_hash, request_hash,
                         resource_id, created_at)
                     SELECT 'office-create', account.id, ?, ?, ?, ?
                     FROM platform_accounts account
                     WHERE account.id=? AND account.status='active'
                       AND account.deleted_at IS NULL
                     ON CONFLICT(scope, account_id, key_hash) DO NOTHING`,
                    [
                        input.idempotencyKeyHash,
                        input.requestHash,
                        input.id,
                        input.receiptCreatedAt,
                        input.ownerAccountId
                    ]
                ),
                sqlStatement(
                    this.database,
                    `INSERT INTO fudaba_offices
                        (id, owner_account_id, slug, name, intro, city, address,
                         latitude, longitude, accent, cover_object_key,
                         pending_cover_object_key, pending_cover_submitted_at,
                         is_open, visitor_count, status, revision, created_at,
                         updated_at, archived_at)
                     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL,
                            ?, ?, ?, ?, ?, ?, ?
                     FROM platform_accounts account
                     JOIN fudaba_mutation_receipts receipt
                       ON receipt.scope='office-create'
                      AND receipt.account_id=account.id
                      AND receipt.key_hash=?
                     WHERE account.id=? AND account.status='active'
                       AND account.deleted_at IS NULL
                       AND receipt.request_hash=? AND receipt.resource_id=?`,
                    [
                        input.id,
                        input.ownerAccountId,
                        input.slug,
                        input.name,
                        input.intro,
                        input.city,
                        input.address,
                        input.latitude,
                        input.longitude,
                        input.accent,
                        input.coverObjectKey,
                        this.bindBoolean(input.isOpen),
                        input.visitorCount,
                        input.status,
                        input.revision,
                        input.createdAt,
                        input.updatedAt,
                        input.archivedAt,
                        input.idempotencyKeyHash,
                        input.ownerAccountId,
                        input.requestHash,
                        input.id
                    ]
                ),
                ...input.seriesCodes.map((seriesCode, displayOrder) => sqlStatement(
                    this.database,
                    `INSERT INTO fudaba_office_series_tags
                        (office_id, series_code, display_order)
                     SELECT office.id, (
                         SELECT series.code FROM agencies series
                         WHERE series.code=? AND series.wiki_enabled=?
                     ), ?
                     FROM fudaba_offices office
                     WHERE office.id=? AND office.owner_account_id=?`,
                    [
                        seriesCode,
                        this.bindBoolean(true),
                        displayOrder,
                        input.id,
                        input.ownerAccountId
                    ]
                ))
            ];
            try {
                await this.database.batch(statements);
            } catch (error) {
                if (!await this.enabledOfficeSeriesAvailable(input.seriesCodes)) {
                    return { status: 'unavailable' };
                }
                throw error;
            }
            const receipt = await this.findMutationReceipt(
                'office-create',
                input.ownerAccountId,
                input.idempotencyKeyHash
            );
            if (!receipt) return { status: 'unavailable' };
            if (receipt.request_hash !== input.requestHash) {
                return { status: 'idempotency-conflict' };
            }
            const created = await this.findOfficeForOwner(
                receipt.resource_id,
                input.ownerAccountId
            );
            if (!created) {
                throw new Error('Fudaba office receipt references a missing office');
            }
            return {
                status: 'saved',
                office: created,
                previousPendingObjectKey: null
            };
        });
    }

    updateOfficeForOwner(
        input: UpdateOwnedFudabaOfficeInput
    ): Promise<FudabaOfficeMutationResult> {
        return this.serializeWrite(async () => {
            const ownerRevisionGuard = `office.id=?
                AND office.owner_account_id=? AND office.revision=?
                AND office.status='active'
                AND EXISTS (
                    SELECT 1 FROM platform_accounts account
                    WHERE account.id=office.owner_account_id
                      AND account.status='active' AND account.deleted_at IS NULL
                )`;
            const statements = [
                sqlStatement(
                    this.database,
                    `UPDATE fudaba_offices AS office SET revision=revision
                     WHERE ${ownerRevisionGuard}`,
                    [input.officeId, input.ownerAccountId, input.expectedRevision]
                ),
                sqlStatement(
                    this.database,
                    `DELETE FROM fudaba_office_public_locations
                     WHERE office_id=? AND EXISTS (
                         SELECT 1 FROM fudaba_offices office
                         WHERE ${ownerRevisionGuard}
                           AND (
                               office.latitude<>? OR office.longitude<>?
                               OR office.city<>? OR office.address<>?
                           )
                     )`,
                    [
                        input.officeId,
                        input.officeId,
                        input.ownerAccountId,
                        input.expectedRevision,
                        input.latitude,
                        input.longitude,
                        input.city,
                        input.address
                    ]
                ),
                sqlStatement(
                    this.database,
                    `DELETE FROM fudaba_office_series_tags
                     WHERE office_id=? AND EXISTS (
                         SELECT 1 FROM fudaba_offices office
                         WHERE ${ownerRevisionGuard}
                     )`,
                    [
                        input.officeId,
                        input.officeId,
                        input.ownerAccountId,
                        input.expectedRevision
                    ]
                ),
                ...input.seriesCodes.map((seriesCode, displayOrder) => sqlStatement(
                    this.database,
                    `INSERT INTO fudaba_office_series_tags
                        (office_id, series_code, display_order)
                     SELECT office.id, (
                         SELECT series.code FROM agencies series
                         WHERE series.code=? AND series.wiki_enabled=?
                     ), ?
                     FROM fudaba_offices office
                     WHERE ${ownerRevisionGuard}`,
                    [
                        seriesCode,
                        this.bindBoolean(true),
                        displayOrder,
                        input.officeId,
                        input.ownerAccountId,
                        input.expectedRevision
                    ]
                )),
                sqlStatement(
                    this.database,
                    `UPDATE fudaba_offices AS office
                     SET name=?, intro=?, city=?, address=?, latitude=?,
                         longitude=?, accent=?, is_open=?, updated_at=?,
                         revision=revision+1
                     WHERE ${ownerRevisionGuard}`,
                    [
                        input.name,
                        input.intro,
                        input.city,
                        input.address,
                        input.latitude,
                        input.longitude,
                        input.accent,
                        this.bindBoolean(input.isOpen),
                        input.updatedAt,
                        input.officeId,
                        input.ownerAccountId,
                        input.expectedRevision
                    ]
                )
            ];
            let results;
            try {
                results = await this.database.batch(statements);
            } catch (error) {
                if (!await this.enabledOfficeSeriesAvailable(input.seriesCodes)) {
                    return { status: 'unavailable' };
                }
                throw error;
            }
            const first = results[0]?.meta.changes ?? 0;
            const final = results.at(-1)?.meta.changes ?? 0;
            if (first !== 1 || final !== 1) {
                return this.officeMutationFailure(
                    input.officeId,
                    input.ownerAccountId,
                    input.expectedRevision,
                    (office) => office.status === 'active'
                );
            }
            const office = await this.findOfficeForOwner(
                input.officeId,
                input.ownerAccountId
            );
            if (!office) throw new Error('Updated Fudaba office is unavailable');
            return { status: 'saved', office, previousPendingObjectKey: null };
        });
    }

    archiveOfficeForOwner(input: {
        officeId: string;
        ownerAccountId: string;
        expectedRevision: number;
        archivedAt: string;
    }): Promise<FudabaOfficeMutationResult> {
        return this.serializeWrite(async () => {
            const result = await executeSql(
                this.database,
                `UPDATE fudaba_offices AS office
                 SET status='archived', archived_at=?, updated_at=?,
                     revision=revision+1
                 WHERE office.id=? AND office.owner_account_id=?
                   AND office.revision=? AND office.status='active'
                   AND EXISTS (
                       SELECT 1 FROM platform_accounts account
                       WHERE account.id=office.owner_account_id
                         AND account.status='active' AND account.deleted_at IS NULL
                   )`,
                [
                    input.archivedAt,
                    input.archivedAt,
                    input.officeId,
                    input.ownerAccountId,
                    input.expectedRevision
                ]
            );
            if (result.meta.changes !== 1) {
                return this.officeMutationFailure(
                    input.officeId,
                    input.ownerAccountId,
                    input.expectedRevision,
                    (office) => office.status === 'active'
                );
            }
            const office = await this.findOfficeForOwner(
                input.officeId,
                input.ownerAccountId
            );
            if (!office) throw new Error('Archived Fudaba office is unavailable');
            return { status: 'saved', office, previousPendingObjectKey: null };
        });
    }

    restoreOfficeForOwner(input: {
        officeId: string;
        ownerAccountId: string;
        expectedRevision: number;
        restoredAt: string;
    }): Promise<FudabaOfficeMutationResult> {
        return this.serializeWrite(async () => {
            const result = await executeSql(
                this.database,
                `UPDATE fudaba_offices AS office
                 SET status='active', archived_at=NULL, updated_at=?,
                     revision=revision+1
                 WHERE office.id=? AND office.owner_account_id=?
                   AND office.revision=? AND office.status='archived'
                   AND EXISTS (
                       SELECT 1 FROM platform_accounts account
                       WHERE account.id=office.owner_account_id
                         AND account.status='active' AND account.deleted_at IS NULL
                   )`,
                [
                    input.restoredAt,
                    input.officeId,
                    input.ownerAccountId,
                    input.expectedRevision
                ]
            );
            if (result.meta.changes !== 1) {
                return this.officeMutationFailure(
                    input.officeId,
                    input.ownerAccountId,
                    input.expectedRevision,
                    (office) => office.status === 'archived'
                );
            }
            const office = await this.findOfficeForOwner(
                input.officeId,
                input.ownerAccountId
            );
            if (!office) throw new Error('Restored Fudaba office is unavailable');
            return { status: 'saved', office, previousPendingObjectKey: null };
        });
    }

    reservePendingOfficeCoverForOwner(input: {
        officeId: string;
        ownerAccountId: string;
        objectKey: string;
        expectedRevision: number;
        submittedAt: string;
    }): Promise<FudabaOfficeMutationResult> {
        return this.serializeWrite(async () => {
            const result = await executeSql(
                this.database,
                `UPDATE fudaba_offices AS office
                 SET pending_cover_object_key=?, pending_cover_submitted_at=?,
                     updated_at=?, revision=revision+1
                 WHERE office.id=? AND office.owner_account_id=?
                   AND office.revision=? AND office.status='active'
                   AND office.pending_cover_object_key IS NULL
                   AND EXISTS (
                       SELECT 1 FROM platform_accounts account
                       WHERE account.id=office.owner_account_id
                         AND account.status='active' AND account.deleted_at IS NULL
                   )`,
                [
                    input.objectKey,
                    input.submittedAt,
                    input.submittedAt,
                    input.officeId,
                    input.ownerAccountId,
                    input.expectedRevision
                ]
            );
            if (result.meta.changes !== 1) {
                return this.officeMutationFailure(
                    input.officeId,
                    input.ownerAccountId,
                    input.expectedRevision,
                    (office) => office.status === 'active',
                    true
                );
            }
            const office = await this.findOfficeForOwner(
                input.officeId,
                input.ownerAccountId
            );
            if (!office) throw new Error('Reserved Fudaba cover is unavailable');
            return { status: 'saved', office, previousPendingObjectKey: null };
        });
    }

    clearPendingOfficeCoverForOwner(input: {
        officeId: string;
        ownerAccountId: string;
        objectKey: string;
        expectedRevision: number;
        updatedAt: string;
    }): Promise<FudabaOfficeMutationResult> {
        return this.serializeWrite(async () => {
            const result = await executeSql(
                this.database,
                `UPDATE fudaba_offices AS office
                 SET pending_cover_object_key=NULL,
                     pending_cover_submitted_at=NULL, updated_at=?,
                     revision=revision+1
                 WHERE office.id=? AND office.owner_account_id=?
                   AND office.revision=? AND office.pending_cover_object_key=?`,
                [
                    input.updatedAt,
                    input.officeId,
                    input.ownerAccountId,
                    input.expectedRevision,
                    input.objectKey
                ]
            );
            if (result.meta.changes !== 1) {
                return this.officeMutationFailure(
                    input.officeId,
                    input.ownerAccountId,
                    input.expectedRevision,
                    (office) => office.pending_cover_object_key !== null
                );
            }
            const office = await this.findOfficeForOwner(
                input.officeId,
                input.ownerAccountId
            );
            if (!office) throw new Error('Withdrawn Fudaba cover is unavailable');
            return {
                status: 'saved',
                office,
                previousPendingObjectKey: input.objectKey
            };
        });
    }

    updateOfficeStatusForOwner(input: {
        officeId: string;
        ownerAccountId: string;
        status: FudabaOfficeRecord['status'];
        archivedAt: string | null;
        updatedAt: string;
        expectedRevision: number;
    }): Promise<boolean> {
        return this.serializeWrite(async () => {
            const result = await executeSql(
                this.database,
                `UPDATE fudaba_offices
                 SET status=?, archived_at=?, updated_at=?, revision=revision+1
                 WHERE id=? AND owner_account_id=? AND revision=?`,
                [
                    input.status,
                    input.archivedAt,
                    input.updatedAt,
                    input.officeId,
                    input.ownerAccountId,
                    input.expectedRevision
                ]
            );
            return result.meta.changes === 1;
        });
    }

    async findOfficePublicLocationForOwner(
        officeId: string,
        ownerAccountId: string
    ): Promise<FudabaOfficePublicLocationRecord | null> {
        const row = await queryOne<FudabaOfficePublicLocationRow>(
            this.database,
            `SELECT ${QUALIFIED_OFFICE_PUBLIC_LOCATION_COLUMNS}
             FROM fudaba_office_public_locations location
             JOIN fudaba_offices office ON office.id=location.office_id
             WHERE location.office_id=? AND office.owner_account_id=?`,
            [officeId, ownerAccountId]
        );
        return row ? officePublicLocationRecord(row) : null;
    }

    private async findWritableOfficePublicLocationForOwner(
        officeId: string,
        ownerAccountId: string,
        requireActiveOffice: boolean
    ): Promise<FudabaOfficePublicLocationRecord | null> {
        const activeOfficeCondition = requireActiveOffice
            ? `AND office.status='active'`
            : '';
        const row = await queryOne<FudabaOfficePublicLocationRow>(
            this.database,
            `SELECT ${QUALIFIED_OFFICE_PUBLIC_LOCATION_COLUMNS}
             FROM fudaba_office_public_locations location
             JOIN fudaba_offices office ON office.id=location.office_id
             JOIN platform_accounts account ON account.id=office.owner_account_id
             WHERE location.office_id=? AND office.owner_account_id=?
               ${activeOfficeCondition}
               AND account.status='active' AND account.deleted_at IS NULL`,
            [officeId, ownerAccountId]
        );
        return row ? officePublicLocationRecord(row) : null;
    }

    private async officeLocationWriteFailure(
        officeId: string,
        ownerAccountId: string,
        requireActiveOffice: boolean
    ): Promise<FudabaOfficeLocationMutationResult> {
        const current = await this.findWritableOfficePublicLocationForOwner(
            officeId,
            ownerAccountId,
            requireActiveOffice
        );
        return current
            ? { status: 'conflict', revision: current.revision }
            : { status: 'unavailable' };
    }

    saveOfficePublicLocationForOwner(input: {
        officeId: string;
        ownerAccountId: string;
        latitudeE1: number;
        longitudeE1: number;
        expectedRevision: number | null;
        submittedAt: string;
    }): Promise<FudabaOfficeLocationMutationResult> {
        return this.serializeWrite(async () => {
            const result = await this.database.prepare(
                `INSERT INTO fudaba_office_public_locations
                    (office_id, latitude_e1, longitude_e1, review_state,
                     revision, submitted_at, reviewed_at, reviewed_by, review_note,
                     review_audit_id)
                 SELECT office.id, ?, ?, 'pending', 0, ?, NULL, NULL, '', NULL
                 FROM fudaba_offices office
                 JOIN platform_accounts account ON account.id=office.owner_account_id
                 WHERE office.id=? AND office.owner_account_id=?
                   AND office.status='active'
                   AND account.status='active' AND account.deleted_at IS NULL
                   AND (COALESCE(?, -1)=-1 OR EXISTS (
                       SELECT 1 FROM fudaba_office_public_locations existing
                       WHERE existing.office_id=office.id
                   ))
                 ON CONFLICT (office_id) DO UPDATE SET
                    latitude_e1=excluded.latitude_e1,
                    longitude_e1=excluded.longitude_e1,
                    review_state='pending',
                    revision=fudaba_office_public_locations.revision+1,
                    submitted_at=excluded.submitted_at,
                    reviewed_at=NULL,
                    reviewed_by=NULL,
                    review_note='',
                    review_audit_id=NULL
                 WHERE COALESCE(?, -1)>=0
                   AND fudaba_office_public_locations.revision=?
                   AND EXISTS (
                       SELECT 1 FROM fudaba_offices writable_office
                       JOIN platform_accounts writable_account
                         ON writable_account.id=writable_office.owner_account_id
                       WHERE writable_office.id=
                             fudaba_office_public_locations.office_id
                         AND writable_office.owner_account_id=?
                         AND writable_office.status='active'
                         AND writable_account.status='active'
                         AND writable_account.deleted_at IS NULL
                   )
                 RETURNING ${OFFICE_PUBLIC_LOCATION_COLUMNS}`
            ).bind(
                input.latitudeE1,
                input.longitudeE1,
                input.submittedAt,
                input.officeId,
                input.ownerAccountId,
                input.expectedRevision,
                input.expectedRevision,
                input.expectedRevision,
                input.ownerAccountId
            ).run<FudabaOfficePublicLocationRow>();
            const saved = result.results[0];
            if (saved) {
                return {
                    status: 'saved',
                    location: officePublicLocationRecord(saved)
                };
            }
            return this.officeLocationWriteFailure(
                input.officeId,
                input.ownerAccountId,
                true
            );
        });
    }

    withdrawOfficePublicLocationForOwner(input: {
        officeId: string;
        ownerAccountId: string;
        expectedRevision: number;
    }): Promise<FudabaOfficeLocationMutationResult> {
        return this.serializeWrite(async () => {
            const result = await this.database.prepare(
                `DELETE FROM fudaba_office_public_locations
                 WHERE office_id=? AND revision=?
                   AND EXISTS (
                       SELECT 1 FROM fudaba_offices office
                       JOIN platform_accounts account
                         ON account.id=office.owner_account_id
                       WHERE office.id=fudaba_office_public_locations.office_id
                         AND office.owner_account_id=?
                         AND account.status='active'
                         AND account.deleted_at IS NULL
                   )
                 RETURNING ${OFFICE_PUBLIC_LOCATION_COLUMNS}`
            ).bind(
                input.officeId,
                input.expectedRevision,
                input.ownerAccountId
            ).run<FudabaOfficePublicLocationRow>();
            const removed = result.results[0];
            if (removed) {
                return {
                    status: 'saved',
                    location: officePublicLocationRecord(removed)
                };
            }
            return this.officeLocationWriteFailure(
                input.officeId,
                input.ownerAccountId,
                false
            );
        });
    }

    async listOfficeLocationReviews(input: {
        reviewState?: FudabaOfficeLocationReviewRecord['review_state'];
        limit: number;
    }): Promise<FudabaOfficeLocationReviewRecord[]> {
        const conditions: string[] = [];
        const parameters: unknown[] = [];
        if (input.reviewState !== undefined) {
            conditions.push('location.review_state=?');
            parameters.push(input.reviewState);
        }
        parameters.push(input.limit);
        const rows = await queryAll<FudabaOfficeLocationReviewRow>(
            this.database,
            `SELECT ${OFFICE_LOCATION_REVIEW_COLUMNS}
             FROM fudaba_office_public_locations location
             JOIN fudaba_offices office ON office.id=location.office_id
             ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
             ORDER BY CASE location.review_state
                          WHEN 'pending' THEN 0
                          WHEN 'published' THEN 1
                          ELSE 2
                      END ASC,
                      location.submitted_at ASC, location.office_id ASC
             LIMIT ?`,
            parameters
        );
        return rows.map(officeLocationReviewRecord);
    }

    reviewOfficePublicLocation(input: {
        officeId: string;
        decision: 'publish' | 'reject';
        expectedRevision: number;
        reviewedAt: string;
        reviewedBy: number;
        reviewNote: string;
        reviewOperationId: string;
        audit: AuditLogInput;
    }): Promise<FudabaOfficeLocationMutationResult> {
        return this.serializeWrite(async () => {
            const [result] = await this.database.batch<FudabaOfficePublicLocationRow>([
                this.database.prepare(
                    `UPDATE fudaba_office_public_locations
                     SET review_state=?, revision=revision+1, reviewed_at=?,
                         reviewed_by=?, review_note=?, review_audit_id=?
                     WHERE office_id=? AND revision=?
                     RETURNING ${OFFICE_PUBLIC_LOCATION_COLUMNS}`
                ).bind(
                    input.decision === 'publish' ? 'published' : 'rejected',
                    input.reviewedAt,
                    input.reviewedBy,
                    input.reviewNote,
                    input.reviewOperationId,
                    input.officeId,
                    input.expectedRevision
                ),
                this.database.prepare(
                    `INSERT INTO logs
                        (username, producername, action, target, ip, time)
                     SELECT ?, ?, ?, ?, ?, ?
                     FROM fudaba_office_public_locations
                     WHERE office_id=? AND review_audit_id=?`
                ).bind(
                    input.audit.username,
                    input.audit.producername,
                    input.audit.action,
                    input.audit.target,
                    input.audit.ip,
                    input.audit.time,
                    input.officeId,
                    input.reviewOperationId
                )
            ]);
            const saved = result?.results[0];
            if (saved) {
                return {
                    status: 'saved',
                    location: officePublicLocationRecord(saved)
                };
            }
            const current = await queryOne<FudabaOfficePublicLocationRow>(
                this.database,
                `SELECT ${OFFICE_PUBLIC_LOCATION_COLUMNS}
                 FROM fudaba_office_public_locations
                 WHERE office_id=?`,
                [input.officeId]
            );
            return current
                ? { status: 'conflict', revision: Number(current.revision) }
                : { status: 'unavailable' };
        });
    }

    createCard(input: NewFudabaCardInput): Promise<FudabaCardRecord> {
        return this.serializeWrite(async () => {
            await executeSql(
                this.database,
                `INSERT INTO fudaba_cards
                    (id, owner_account_id, producer_name, display_name,
                     series_code, favorite_idol, front_object_key, back_object_key,
                     accent, bio, trade_note, available, source_url, source_label,
                     source_credit, media_rights_status, publication_status,
                     revision, created_at, updated_at, deleted_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    input.id,
                    input.ownerAccountId,
                    input.producerName,
                    input.displayName,
                    input.seriesCode,
                    input.favoriteIdol,
                    input.frontObjectKey,
                    input.backObjectKey,
                    input.accent,
                    input.bio,
                    input.tradeNote,
                    this.bindBoolean(input.available),
                    input.sourceUrl,
                    input.sourceLabel,
                    input.sourceCredit,
                    input.mediaRightsStatus,
                    input.publicationStatus,
                    input.revision,
                    input.createdAt,
                    input.updatedAt,
                    input.deletedAt
                ]
            );
            const created = await this.findCardById(input.id);
            if (!created) throw new Error('Fudaba card was not created');
            return created;
        });
    }

    async findCardById(id: string): Promise<FudabaCardRecord | null> {
        const row = await queryOne<FudabaCardRow>(
            this.database,
            `SELECT ${CARD_COLUMNS} FROM fudaba_cards WHERE id=?`,
            [id]
        );
        return row ? cardRecord(row) : null;
    }

    async listCardsForOwner(ownerAccountId: string): Promise<FudabaCardRecord[]> {
        const rows = await queryAll<FudabaCardRow>(
            this.database,
            `SELECT ${CARD_COLUMNS}
             FROM fudaba_cards
             WHERE owner_account_id=? AND deleted_at IS NULL
             ORDER BY created_at DESC, id DESC`,
            [ownerAccountId]
        );
        return rows.map(cardRecord);
    }

    async findCardForOwner(
        cardId: string,
        ownerAccountId: string
    ): Promise<FudabaCardRecord | null> {
        const row = await queryOne<FudabaCardRow>(
            this.database,
            `SELECT ${CARD_COLUMNS}
             FROM fudaba_cards
             WHERE id=? AND owner_account_id=? AND deleted_at IS NULL`,
            [cardId, ownerAccountId]
        );
        return row ? cardRecord(row) : null;
    }

    private async findActiveCardForOwner(
        cardId: string,
        ownerAccountId: string
    ): Promise<FudabaCardRecord | null> {
        const row = await queryOne<FudabaCardRow>(
            this.database,
            `SELECT ${CARD_COLUMNS}
             FROM fudaba_cards
             WHERE id=? AND owner_account_id=? AND deleted_at IS NULL
               AND EXISTS (
                   SELECT 1 FROM platform_accounts account
                   WHERE account.id=fudaba_cards.owner_account_id
                     AND account.status='active' AND account.deleted_at IS NULL
               )`,
            [cardId, ownerAccountId]
        );
        return row ? cardRecord(row) : null;
    }

    private cardWriteFailure(
        current: FudabaCardRecord | null,
        expectedRevision: number
    ): FudabaCardMutationResult {
        if (!current) return { status: 'unavailable' };
        if (current.revision !== expectedRevision) {
            return { status: 'conflict', revision: current.revision };
        }
        return { status: 'unavailable' };
    }

    private savedCardResult(
        row: FudabaCardRow,
        previousObjectKey: string | null
    ): FudabaCardMutationResult {
        return {
            status: 'saved',
            card: cardRecord(row),
            previousObjectKey
        };
    }

    createCardForOwner(
        input: CreateOwnedFudabaCardInput
    ): Promise<FudabaCardMutationResult> {
        return this.serializeWrite(async () => {
            const result = await this.database.prepare(
                `INSERT INTO fudaba_cards
                    (id, owner_account_id, producer_name, display_name,
                     series_code, favorite_idol, front_object_key, back_object_key,
                     accent, bio, trade_note, available, source_url, source_label,
                     source_credit, media_rights_status, publication_status,
                     revision, created_at, updated_at, deleted_at)
                 SELECT ?, account.id, ?, ?, series.code, ?, ?, ?, ?, ?, ?, ?,
                        NULL, NULL, NULL, 'unknown', 'pending', 0, ?, ?, NULL
                 FROM platform_accounts account
                 JOIN agencies series
                   ON series.code=? AND series.wiki_enabled=?
                 WHERE account.id=? AND account.status='active'
                   AND account.deleted_at IS NULL
                 ON CONFLICT(id) DO NOTHING
                 RETURNING ${CARD_COLUMNS}`
            ).bind(
                input.id,
                input.producerName,
                input.displayName,
                input.favoriteIdol,
                input.frontObjectKey,
                input.backObjectKey,
                input.accent,
                input.bio,
                input.tradeNote,
                this.bindBoolean(input.available),
                input.createdAt,
                input.updatedAt,
                input.seriesCode,
                this.bindBoolean(true),
                input.ownerAccountId
            ).run<FudabaCardRow>();
            const saved = result.results[0];
            return saved
                ? this.savedCardResult(saved, null)
                : { status: 'unavailable' };
        });
    }

    updateCardMetadataForOwner(
        input: UpdateOwnedFudabaCardMetadataInput
    ): Promise<FudabaCardMutationResult> {
        return this.serializeWrite(async () => {
            const result = await this.database.prepare(
                `UPDATE fudaba_cards
                 SET producer_name=?, display_name=?, series_code=?, favorite_idol=?,
                     accent=?, bio=?, trade_note=?, available=?,
                     media_rights_status='unknown', publication_status='pending',
                     revision=revision+1, updated_at=?
                 WHERE id=? AND owner_account_id=? AND revision=?
                   AND deleted_at IS NULL
                   AND EXISTS (
                       SELECT 1 FROM platform_accounts account
                       WHERE account.id=fudaba_cards.owner_account_id
                         AND account.status='active' AND account.deleted_at IS NULL
                   )
                   AND EXISTS (
                       SELECT 1 FROM agencies series
                       WHERE series.code=? AND series.wiki_enabled=?
                   )
                 RETURNING ${CARD_COLUMNS}`
            ).bind(
                input.producerName,
                input.displayName,
                input.seriesCode,
                input.favoriteIdol,
                input.accent,
                input.bio,
                input.tradeNote,
                this.bindBoolean(input.available),
                input.updatedAt,
                input.cardId,
                input.ownerAccountId,
                input.expectedRevision,
                input.seriesCode,
                this.bindBoolean(true)
            ).run<FudabaCardRow>();
            const saved = result.results[0];
            if (saved) return this.savedCardResult(saved, null);
            return this.cardWriteFailure(
                await this.findActiveCardForOwner(
                    input.cardId,
                    input.ownerAccountId
                ),
                input.expectedRevision
            );
        });
    }

    updateCardMediaForOwner(
        input: UpdateOwnedFudabaCardMediaInput
    ): Promise<FudabaCardMutationResult> {
        return this.serializeWrite(async () => {
            const current = await this.findActiveCardForOwner(
                input.cardId,
                input.ownerAccountId
            );
            if (!current || current.revision !== input.expectedRevision) {
                return this.cardWriteFailure(current, input.expectedRevision);
            }
            const objectKeyColumn = input.side === 'front'
                ? 'front_object_key'
                : 'back_object_key';
            const result = await this.database.prepare(
                `UPDATE fudaba_cards
                 SET ${objectKeyColumn}=?, media_rights_status='unknown',
                     publication_status='pending', revision=revision+1, updated_at=?
                 WHERE id=? AND owner_account_id=? AND revision=?
                   AND deleted_at IS NULL
                   AND EXISTS (
                       SELECT 1 FROM platform_accounts account
                       WHERE account.id=fudaba_cards.owner_account_id
                         AND account.status='active' AND account.deleted_at IS NULL
                   )
                 RETURNING ${CARD_COLUMNS}`
            ).bind(
                input.objectKey,
                input.updatedAt,
                input.cardId,
                input.ownerAccountId,
                input.expectedRevision
            ).run<FudabaCardRow>();
            const saved = result.results[0];
            if (saved) {
                return this.savedCardResult(
                    saved,
                    input.side === 'front'
                        ? current.front_object_key
                        : current.back_object_key
                );
            }
            return this.cardWriteFailure(
                await this.findActiveCardForOwner(
                    input.cardId,
                    input.ownerAccountId
                ),
                input.expectedRevision
            );
        });
    }

    softDeleteCardForOwner(
        input: SoftDeleteOwnedFudabaCardInput
    ): Promise<FudabaCardMutationResult> {
        return this.serializeWrite(async () => {
            const result = await this.database.prepare(
                `UPDATE fudaba_cards
                 SET deleted_at=?, updated_at=?, media_rights_status='unknown',
                     publication_status='pending', revision=revision+1
                 WHERE id=? AND owner_account_id=? AND revision=?
                   AND deleted_at IS NULL
                   AND EXISTS (
                       SELECT 1 FROM platform_accounts account
                       WHERE account.id=fudaba_cards.owner_account_id
                         AND account.status='active' AND account.deleted_at IS NULL
                   )
                 RETURNING ${CARD_COLUMNS}`
            ).bind(
                input.deletedAt,
                input.deletedAt,
                input.cardId,
                input.ownerAccountId,
                input.expectedRevision
            ).run<FudabaCardRow>();
            const saved = result.results[0];
            if (saved) return this.savedCardResult(saved, null);
            return this.cardWriteFailure(
                await this.findActiveCardForOwner(
                    input.cardId,
                    input.ownerAccountId
                ),
                input.expectedRevision
            );
        });
    }

    placeOwnedCard(input: {
        officeId: string;
        cardId: string;
        ownerAccountId: string;
        pinnedAt: string;
        positionX: number;
        positionY: number;
        rotation: number;
        zIndex: number;
    }): Promise<boolean> {
        return this.serializeWrite(async () => {
            const result = await executeSql(
                this.database,
                `INSERT INTO fudaba_office_cards
                    (office_id, card_id, pinned_at, position_x, position_y,
                     rotation, z_index, revision, updated_at)
                 SELECT office.id, card.id, ?, ?, ?, ?, ?, 0, ?
                 FROM fudaba_offices office
                 JOIN fudaba_cards card ON card.id=?
                 WHERE office.id=? AND office.status='active'
                   AND card.owner_account_id=? AND card.deleted_at IS NULL
                 ON CONFLICT(office_id, card_id) DO NOTHING`,
                [
                    input.pinnedAt,
                    input.positionX,
                    input.positionY,
                    input.rotation,
                    input.zIndex,
                    input.pinnedAt,
                    input.cardId,
                    input.officeId,
                    input.ownerAccountId
                ]
            );
            return result.meta.changes === 1;
        });
    }

    private async cardPlacementSaveFailure(input: {
        officeId: string;
        cardId: string;
        ownerAccountId: string;
    }): Promise<FudabaCardPlacementSaveResult> {
        const current = await queryOne<{ revision: number | string }>(
            this.database,
            `SELECT placement.revision
             FROM fudaba_office_cards placement
             JOIN fudaba_offices office ON office.id=placement.office_id
             JOIN platform_accounts office_owner
               ON office_owner.id=office.owner_account_id
             JOIN fudaba_cards card ON card.id=placement.card_id
             JOIN platform_accounts account ON account.id=card.owner_account_id
             JOIN agencies series ON series.code=card.series_code
             WHERE placement.office_id=? AND placement.card_id=?
               AND card.owner_account_id=?
               AND account.status='active' AND account.deleted_at IS NULL
               AND ${OPEN_OFFICE_CARD_WALL_ELIGIBILITY}
               AND card.publication_status='published'
               AND card.media_rights_status='approved'
               AND card.deleted_at IS NULL AND series.wiki_enabled`,
            [input.officeId, input.cardId, input.ownerAccountId]
        );
        return current
            ? { status: 'conflict', revision: Number(current.revision) }
            : { status: 'unavailable' };
    }

    private async cardPlacementRemovalFailure(input: {
        officeId: string;
        cardId: string;
        ownerAccountId: string;
        expectedRevision: number;
    }): Promise<FudabaCardPlacementRemovalResult> {
        const current = await queryOne<{
            revision: number | string;
            in_use: boolean | number | string;
        }>(
            this.database,
            `SELECT placement.revision, EXISTS (
                 SELECT 1 FROM fudaba_exchange_requests exchange_request
                 WHERE exchange_request.office_id=placement.office_id
                   AND exchange_request.wanted_card_id=placement.card_id
             ) AS in_use
             FROM fudaba_office_cards placement
             JOIN fudaba_cards card ON card.id=placement.card_id
             JOIN platform_accounts account ON account.id=card.owner_account_id
             WHERE placement.office_id=? AND placement.card_id=?
               AND card.owner_account_id=?
               AND account.status='active' AND account.deleted_at IS NULL`,
            [input.officeId, input.cardId, input.ownerAccountId]
        );
        if (!current) return { status: 'unavailable' };
        const revision = Number(current.revision);
        if (revision !== input.expectedRevision) {
            return { status: 'conflict', revision };
        }
        return booleanValue(current.in_use)
            ? { status: 'in-use', revision }
            : { status: 'conflict', revision };
    }

    saveCardPlacementForOwner(input: {
        officeId: string;
        cardId: string;
        ownerAccountId: string;
        positionX: number;
        positionY: number;
        rotation: number;
        zIndex: number;
        expectedRevision: number | null;
        updatedAt: string;
    }): Promise<FudabaCardPlacementSaveResult> {
        return this.serializeWrite(async () => {
            let row: FudabaCardPlacementRow | undefined;
            if (input.expectedRevision === null) {
                const result = await this.database.prepare(
                    `INSERT INTO fudaba_office_cards
                        (office_id, card_id, pinned_at, position_x, position_y,
                         rotation, z_index, revision, updated_at)
                     SELECT office.id, card.id, ?, ?, ?, ?, ?, 0, ?
                     FROM fudaba_offices office
                     JOIN platform_accounts office_owner
                       ON office_owner.id=office.owner_account_id
                     JOIN fudaba_cards card ON card.id=?
                     JOIN platform_accounts account
                       ON account.id=card.owner_account_id
                     JOIN agencies series
                       ON series.code=card.series_code
                     WHERE office.id=?
                       AND ${OPEN_OFFICE_CARD_WALL_ELIGIBILITY}
                       AND card.owner_account_id=?
                       AND card.publication_status='published'
                       AND card.media_rights_status='approved'
                       AND card.deleted_at IS NULL AND series.wiki_enabled
                       AND account.status='active' AND account.deleted_at IS NULL
                     ON CONFLICT (office_id, card_id) DO NOTHING
                     RETURNING ${CARD_PLACEMENT_COLUMNS}`
                ).bind(
                    input.updatedAt,
                    input.positionX,
                    input.positionY,
                    input.rotation,
                    input.zIndex,
                    input.updatedAt,
                    input.cardId,
                    input.officeId,
                    input.ownerAccountId
                ).run<FudabaCardPlacementRow>();
                row = result.results[0];
            } else {
                const result = await this.database.prepare(
                    `UPDATE fudaba_office_cards AS placement
                     SET position_x=?, position_y=?, rotation=?, z_index=?,
                         revision=placement.revision+1, updated_at=?
                     WHERE placement.office_id=? AND placement.card_id=?
                       AND placement.revision=?
                       AND EXISTS (
                           SELECT 1
                           FROM fudaba_offices office
                           JOIN platform_accounts office_owner
                             ON office_owner.id=office.owner_account_id
                           JOIN fudaba_cards card ON card.id=placement.card_id
                           JOIN platform_accounts account
                             ON account.id=card.owner_account_id
                           JOIN agencies series
                             ON series.code=card.series_code
                           WHERE office.id=placement.office_id
                             AND ${OPEN_OFFICE_CARD_WALL_ELIGIBILITY}
                             AND card.owner_account_id=?
                             AND card.publication_status='published'
                             AND card.media_rights_status='approved'
                             AND card.deleted_at IS NULL AND series.wiki_enabled
                             AND account.status='active'
                             AND account.deleted_at IS NULL
                       )
                     RETURNING ${CARD_PLACEMENT_COLUMNS}`
                ).bind(
                    input.positionX,
                    input.positionY,
                    input.rotation,
                    input.zIndex,
                    input.updatedAt,
                    input.officeId,
                    input.cardId,
                    input.expectedRevision,
                    input.ownerAccountId
                ).run<FudabaCardPlacementRow>();
                row = result.results[0];
            }
            if (row) {
                return {
                    status: 'saved',
                    placement: cardPlacementRecord(row),
                    created: input.expectedRevision === null
                };
            }
            return this.cardPlacementSaveFailure({
                officeId: input.officeId,
                cardId: input.cardId,
                ownerAccountId: input.ownerAccountId
            });
        });
    }

    removeCardPlacementForOwner(input: {
        officeId: string;
        cardId: string;
        ownerAccountId: string;
        expectedRevision: number;
    }): Promise<FudabaCardPlacementRemovalResult> {
        return this.serializeWrite(async () => {
            const result = await this.database.prepare(
                `DELETE FROM fudaba_office_cards AS placement
                 WHERE placement.office_id=? AND placement.card_id=?
                   AND placement.revision=?
                   AND EXISTS (
                       SELECT 1 FROM fudaba_cards card
                       JOIN platform_accounts account
                         ON account.id=card.owner_account_id
                       WHERE card.id=placement.card_id
                         AND card.owner_account_id=?
                         AND account.status='active'
                         AND account.deleted_at IS NULL
                   )
                   AND NOT EXISTS (
                       SELECT 1 FROM fudaba_exchange_requests exchange_request
                       WHERE exchange_request.office_id=placement.office_id
                         AND exchange_request.wanted_card_id=placement.card_id
                   )
                 RETURNING revision`
            ).bind(
                input.officeId,
                input.cardId,
                input.expectedRevision,
                input.ownerAccountId
            ).run<{ revision: number | string }>();
            const removed = result.results[0];
            if (removed) {
                return {
                    status: 'removed',
                    revision: Number(removed.revision) + 1
                };
            }
            return this.cardPlacementRemovalFailure({
                officeId: input.officeId,
                cardId: input.cardId,
                ownerAccountId: input.ownerAccountId,
                expectedRevision: input.expectedRevision
            });
        });
    }

    createMessage(input: {
        id: string;
        officeId: string;
        authorAccountId: string;
        content: string;
        createdAt: string;
    }): Promise<boolean> {
        return this.serializeWrite(async () => {
            const result = await executeSql(
                this.database,
                `INSERT INTO fudaba_messages
                    (id, office_id, author_account_id, content, created_at)
                 SELECT ?, office.id, ?, ?, ?
                 FROM fudaba_offices office
                 WHERE office.id=? AND office.status<>'archived'
                 ON CONFLICT(id) DO NOTHING`,
                [
                    input.id,
                    input.authorAccountId,
                    input.content,
                    input.createdAt,
                    input.officeId
                ]
            );
            return result.meta.changes === 1;
        });
    }

    createExchangeRequest(input: {
        id: string;
        officeId: string;
        requesterAccountId: string;
        recipientAccountId: string;
        wantedCardId: string;
        offeredCardId: string | null;
        note: string;
        createdAt: string;
    }): Promise<FudabaExchangeRequestRecord | null> {
        return this.serializeWrite(async () => {
            const row = await queryOne<FudabaExchangeRequestRow>(
                this.database,
                `INSERT INTO fudaba_exchange_requests
                    (id, office_id, requester_account_id, recipient_account_id,
                     wanted_card_id, offered_card_id, note, status, version,
                     created_at, updated_at, resolved_at)
                 SELECT ?, office.id, requester.id, recipient.id, wanted.id,
                        offered.id, ?, 'pending', 0, ?, ?, NULL
                 FROM fudaba_offices office
                 JOIN fudaba_office_cards placement
                   ON placement.office_id=office.id
                 JOIN fudaba_cards wanted
                   ON wanted.id=placement.card_id
                 JOIN platform_accounts requester ON requester.id=?
                 JOIN platform_accounts recipient ON recipient.id=?
                 LEFT JOIN fudaba_cards offered ON offered.id=?
                 WHERE office.id=? AND office.status<>'archived'
                   AND wanted.id=? AND wanted.owner_account_id=recipient.id
                   AND wanted.deleted_at IS NULL
                   AND requester.id<>recipient.id
                   AND (CAST(? AS TEXT) IS NULL OR (
                       offered.owner_account_id=requester.id
                       AND offered.deleted_at IS NULL
                       AND offered.id<>wanted.id
                   ))
                 ON CONFLICT DO NOTHING
                 RETURNING ${EXCHANGE_COLUMNS}`,
                [
                    input.id,
                    input.note,
                    input.createdAt,
                    input.createdAt,
                    input.requesterAccountId,
                    input.recipientAccountId,
                    input.offeredCardId,
                    input.officeId,
                    input.wantedCardId,
                    input.offeredCardId
                ]
            );
            return row ? exchangeRecord(row) : null;
        });
    }

    setCardInteraction(input: {
        kind: 'like' | 'favorite';
        cardId: string;
        accountId: string;
        active: boolean;
        createdAt: string;
    }): Promise<boolean> {
        const table = input.kind === 'like'
            ? 'fudaba_card_likes'
            : 'fudaba_card_favorites';
        return this.serializeWrite(async () => {
            const result = input.active
                ? await executeSql(
                    this.database,
                    `INSERT INTO ${table} (card_id, account_id, created_at)
                     SELECT card.id, account.id, ?
                     FROM fudaba_cards card
                     JOIN platform_accounts account ON account.id=?
                     WHERE card.id=? AND card.deleted_at IS NULL
                     ON CONFLICT(card_id, account_id) DO NOTHING`,
                    [input.createdAt, input.accountId, input.cardId]
                )
                : await executeSql(
                    this.database,
                    `DELETE FROM ${table} WHERE card_id=? AND account_id=?`,
                    [input.cardId, input.accountId]
                );
            return result.meta.changes === 1;
        });
    }

    createModerationCase(
        input: NewFudabaModerationCaseInput
    ): Promise<FudabaModerationCaseRecord> {
        return this.serializeWrite(async () => {
            const row = await queryOne<FudabaModerationCaseRow>(
                this.database,
                `INSERT INTO fudaba_moderation_cases
                    (id, resource_kind, resource_id, reporter_account_id, reason,
                     details, state, backoffice_actor_id, resolution, created_at,
                     updated_at, resolved_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 RETURNING ${MODERATION_COLUMNS}`,
                [
                    input.id,
                    input.resourceKind,
                    input.resourceId,
                    input.reporterAccountId,
                    input.reason,
                    input.details,
                    input.state,
                    input.backofficeActorId,
                    input.resolution,
                    input.createdAt,
                    input.updatedAt,
                    input.resolvedAt
                ]
            );
            if (!row) throw new Error('Fudaba moderation case was not created');
            return moderationRecord(row);
        });
    }
}
