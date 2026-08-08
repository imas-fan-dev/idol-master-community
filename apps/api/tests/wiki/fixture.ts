import { createHonoApp } from '@/app';
import { HmacBackofficeTokenService } from '@/infra/security/hmac/token-service';
import type { ImageInfo, ImageProcessor } from '@/ports/media';
import type { ObjectStorage, PutObjectOptions, StoredObject } from '@/ports/object-storage';
import type { RuntimeServices } from '@/ports/runtime-services';
import type {
    AddStoryCardSourcesInput,
    AgencyRecord,
    CreateWikiStoryCoverAssetInput,
    CreateWikiAgencyInput,
    CreateWikiGroupInput,
    CreateWikiIdolInput,
    DeleteStoryLinkInput,
    DeleteWikiGroupInput,
    DeleteWikiIdolInput,
    IdolRecord,
    IdolWithAgencyRecord,
    NewStoryBatchInput,
    NewStoryInput,
    SaveWikiEntityMediaInput,
    StoryCardRecord,
    StoryRecord,
    StoryRepository,
    UpdateStoryCardInput,
    UpdateStoryInput,
    UpdateWikiAgencyInput,
    UpdateWikiCategoryInput,
    UpdateWikiGroupInput,
    UpdateWikiIdolInput,
    UpdateWikiStoryCoverAssetInput,
    WikiCategoryRecord,
    WikiGroupMemberRecord,
    WikiGroupRecord,
    WikiImageTransform,
    WikiLayoutInput,
    WikiStoryContentTypeInput,
    WikiStoryContentTypeRecord,
    WikiStoryCoverAssetRecord,
    WikiStorySourcePlatformInput,
    WikiStorySourcePlatformRecord
} from '@/ports/repositories';
import type { ParsedUpload, UploadParser } from '@/ports/http';

const AGENCY_BASE = [
    { id: 1, code: '765', name_cn: '765PRO', color: '#f34f6d' },
    { id: 2, code: '876', name_cn: '876PRO', color: '#656a75' },
    { id: 3, code: 'cg', name_cn: '灰姑娘女孩', color: '#2681c8' },
    { id: 4, code: 'ml', name_cn: '百万现场', color: '#ffc30b' },
    { id: 5, code: 'sidem', name_cn: 'SideM', color: '#0fbe94' },
    { id: 6, code: 'sc', name_cn: '闪耀色彩', color: '#8dbbff' },
    { id: 7, code: 'gk', name_cn: '学园偶像大师', color: '#f39800' }
] as const;

const CONTAIN_TRANSFORM: WikiImageTransform = {
    fit: 'contain', focalX: 0.5, focalY: 0.5, zoom: 1, rotation: 0
};
const COVER_TRANSFORM: WikiImageTransform = {
    fit: 'cover', focalX: 0.5, focalY: 0.5, zoom: 1, rotation: 0
};

export const AGENCIES: AgencyRecord[] = AGENCY_BASE.map((agency, index) => ({
    ...agency,
    wiki_enabled: true,
    display_order: index,
    banner_title: `${agency.name_cn} Banner`,
    icon_object_key: null,
    icon_fit: CONTAIN_TRANSFORM.fit,
    icon_focal_x: CONTAIN_TRANSFORM.focalX,
    icon_focal_y: CONTAIN_TRANSFORM.focalY,
    icon_zoom: CONTAIN_TRANSFORM.zoom,
    icon_rotation: CONTAIN_TRANSFORM.rotation,
    icon_media_revision: 0,
    fallback_artwork_object_key: null,
    layout_revision: 0
}));

const IDOL_NAMES = ['天海春香', '日高爱', '岛村卯月', '春日未来', '天道辉', '樱木真乃', '花海咲季'];

export const IDOLS: IdolWithAgencyRecord[] = AGENCIES.map((agency, index) => ({
    id: index + 1,
    agency_id: agency.id,
    agency_code: agency.code,
    agency_name: agency.name_cn,
    agency_color: agency.color,
    name_cn: IDOL_NAMES[index]!,
    folder_name: `${agency.code}_idol`,
    color: agency.color,
    wiki_enabled: true,
    display_order: 0,
    text_color: '#ffffff',
    wiki_url: null,
    avatar_object_key: null,
    avatar_fit: COVER_TRANSFORM.fit,
    avatar_focal_x: COVER_TRANSFORM.focalX,
    avatar_focal_y: COVER_TRANSFORM.focalY,
    avatar_zoom: COVER_TRANSFORM.zoom,
    avatar_rotation: COVER_TRANSFORM.rotation,
    avatar_media_revision: 0,
    entry_kind: 'idol',
    entry_subtype: null
}));

const GROUPS: WikiGroupRecord[] = AGENCIES.map((agency, index) => ({
    id: index + 1,
    agency_id: agency.id,
    code: `${agency.code}-main`,
    name: `${agency.name_cn} Main`,
    color: agency.color,
    icon_object_key: null,
    icon_fit: CONTAIN_TRANSFORM.fit,
    icon_focal_x: CONTAIN_TRANSFORM.focalX,
    icon_focal_y: CONTAIN_TRANSFORM.focalY,
    icon_zoom: CONTAIN_TRANSFORM.zoom,
    icon_rotation: CONTAIN_TRANSFORM.rotation,
    icon_media_revision: 0,
    display_order: 0,
    is_fallback: false
}));

const MEMBERS: WikiGroupMemberRecord[] = IDOLS.map((idol) => ({
    agency_id: idol.agency_id,
    group_id: idol.agency_id,
    idol_id: idol.id,
    display_order: 0
}));

type MemoryStoryRecord = StoryRecord & { legacy_image_file?: string | null };

function cloneStory(row: MemoryStoryRecord): StoryRecord {
    const { legacy_image_file: _legacyImageFile, ...story } = row;
    return { ...story };
}

function cardFromStory(row: StoryRecord | StoryCardRecord): StoryCardRecord {
    return {
        card_id: row.card_id,
        idol_id: row.idol_id,
        category: row.category,
        card_name: row.card_name,
        subtitle: row.subtitle,
        image_file: row.image_file,
        cover_asset_id: row.cover_asset_id,
        cover_asset_name: row.cover_asset_name,
        cover_asset_object_key: row.cover_asset_object_key,
        cover_asset_revision: row.cover_asset_revision,
        cover_asset_presentation_policy: row.cover_asset_presentation_policy,
        image_fit: row.image_fit,
        image_focal_x: row.image_focal_x,
        image_focal_y: row.image_focal_y,
        image_zoom: row.image_zoom,
        image_rotation: row.image_rotation,
        image_media_revision: row.image_media_revision
    };
}

export class MemoryStoryRepository implements StoryRepository {
    agencies = AGENCIES.map((row) => ({ ...row }));
    idols = IDOLS.map((row) => ({ ...row }));
    groups = GROUPS.map((row) => ({ ...row }));
    members = MEMBERS.map((row) => ({ ...row }));
    categories: Array<WikiCategoryRecord & { idol_id: number }> = IDOLS.map((idol) => ({
        id: idol.id,
        agency_id: idol.agency_id,
        idol_id: idol.id,
        name: idol.agency_code === 'sc' ? 'enzaP卡' : '未分类剧情',
        storage_slug: idol.agency_code === 'sc' ? 'enza_pcard' : 'other',
        background_eligible: idol.agency_code === 'sc',
        display_order: 0,
        show_when_empty: true
    }));
    cards: StoryCardRecord[] = [];
    stories: MemoryStoryRecord[] = [];
    contentTypes: WikiStoryContentTypeRecord[] = [
        {
            id: 1,
            name: '剧情',
            icon_name: 'book-open-text',
            description: '卡片剧情、活动剧情或相关视频内容',
            display_order: 0,
            is_active: true,
            revision: 0
        },
        {
            id: 2,
            name: '语音',
            icon_name: 'mic-2',
            description: '语音、广播或音频内容',
            display_order: 1,
            is_active: true,
            revision: 0
        }
    ];
    sourcePlatforms: WikiStorySourcePlatformRecord[] = [
        {
            id: 1,
            name: 'Bilibili',
            homepage_url: 'https://www.bilibili.com',
            description: 'Bilibili 视频与专栏',
            display_order: 0,
            is_active: true,
            revision: 0
        },
        {
            id: 2,
            name: '其他来源',
            homepage_url: '',
            description: '其他来源',
            display_order: 1,
            is_active: true,
            revision: 0
        }
    ];
    coverAssets: WikiStoryCoverAssetRecord[] = [];
    samples = new Map<string, (StoryRecord & { idol_name: string; agency_name: string }) | null>();
    nextId = 1;
    nextCardId = 1;
    failNextInsert = false;
    failNextUpdate = false;
    failNextDeleteStory = false;
    failNextDeleteCategory = false;
    deletedIdolIds = new Set<number>();

    async initialize() {}
    async close() {}
    async listThemeColors() { return {}; }
    async listAgencies() { return this.agencies.map((row) => ({ ...row })); }
    async listIdolsWithAgencies() {
        return this.idols.filter((row) => !this.deletedIdolIds.has(row.id))
            .map((row) => ({ ...row }));
    }
    async listWikiGroups(agencyId?: number) {
        return this.groups.filter((row) => agencyId === undefined || row.agency_id === agencyId)
            .map((row) => ({ ...row }));
    }
    async findWikiGroupById(id: number) {
        return this.groups.find((row) => row.id === id) ?? null;
    }
    async listWikiGroupMembers(agencyId?: number) {
        return this.members.filter((row) =>
            !this.deletedIdolIds.has(row.idol_id) &&
            (agencyId === undefined || row.agency_id === agencyId)
        )
            .map((row) => ({ ...row }));
    }
    async listWikiCategories(agencyId: number, idolId: number) {
        return this.categories.filter((row) =>
            !this.deletedIdolIds.has(row.idol_id) &&
            row.agency_id === agencyId && row.idol_id === idolId
        ).map(({ idol_id: _idolId, ...row }) => ({ ...row }));
    }
    async findAgencyByName(name: string) {
        return this.agencies.find((row) => row.name_cn === name) ?? null;
    }
    async findAgencyByCode(code: string) {
        return this.agencies.find((row) => row.code === code) ?? null;
    }
    async findAgencyById(id: number) {
        return this.agencies.find((row) => row.id === id) ?? null;
    }
    async findIdolByAgencyAndName(agencyId: number, idolName: string): Promise<IdolRecord | null> {
        const row = this.idols.find((candidate) =>
            !this.deletedIdolIds.has(candidate.id) &&
            candidate.agency_id === agencyId && candidate.name_cn === idolName
        );
        if (!row) return null;
        const { agency_code: _code, agency_name: _name, agency_color: _color, ...idol } = row;
        return { ...idol };
    }
    async findIdolById(id: number): Promise<IdolRecord | null> {
        const row = this.idols.find((candidate) =>
            candidate.id === id && !this.deletedIdolIds.has(candidate.id)
        );
        if (!row) return null;
        const { agency_code: _code, agency_name: _name, agency_color: _color, ...idol } = row;
        return { ...idol };
    }
    async createWikiAgency(input: CreateWikiAgencyInput) {
        if (this.agencies.some((row) => row.code === input.code || row.name_cn === input.name)) {
            throw Object.assign(new Error('企划代码或名称已存在'), { status: 409 });
        }
        const id = Math.max(0, ...this.agencies.map((row) => row.id)) + 1;
        const agency: AgencyRecord = {
            id,
            code: input.code,
            name_cn: input.name,
            color: input.color,
            wiki_enabled: input.wikiEnabled,
            display_order: this.agencies.length,
            banner_title: input.bannerTitle,
            icon_object_key: null,
            icon_fit: CONTAIN_TRANSFORM.fit,
            icon_focal_x: CONTAIN_TRANSFORM.focalX,
            icon_focal_y: CONTAIN_TRANSFORM.focalY,
            icon_zoom: CONTAIN_TRANSFORM.zoom,
            icon_rotation: CONTAIN_TRANSFORM.rotation,
            icon_media_revision: 0,
            fallback_artwork_object_key: null,
            layout_revision: 0
        };
        this.agencies.push(agency);
        this.groups.push({
            id: Math.max(0, ...this.groups.map((row) => row.id)) + 1,
            agency_id: id,
            code: 'other',
            name: '事务所人员与其他',
            color: input.color,
            icon_object_key: null,
            icon_fit: CONTAIN_TRANSFORM.fit,
            icon_focal_x: CONTAIN_TRANSFORM.focalX,
            icon_focal_y: CONTAIN_TRANSFORM.focalY,
            icon_zoom: CONTAIN_TRANSFORM.zoom,
            icon_rotation: CONTAIN_TRANSFORM.rotation,
            icon_media_revision: 0,
            display_order: 0,
            is_fallback: true
        });
        return { ...agency };
    }
    async updateWikiAgency(input: UpdateWikiAgencyInput) {
        const agency = this.agencies.find((row) => row.id === input.id);
        if (!agency) throw Object.assign(new Error('企划不存在'), { status: 404 });
        Object.assign(agency, {
            name_cn: input.name,
            color: input.color,
            banner_title: input.bannerTitle,
            wiki_enabled: input.wikiEnabled
        });
        return { ...agency };
    }
    async createWikiGroup(input: CreateWikiGroupInput) {
        if (!this.agencies.some((row) => row.id === input.agencyId)) {
            throw Object.assign(new Error('企划不存在'), { status: 404 });
        }
        const group: WikiGroupRecord = {
            id: Math.max(0, ...this.groups.map((row) => row.id)) + 1,
            agency_id: input.agencyId,
            code: input.code,
            name: input.name,
            color: input.color,
            icon_object_key: null,
            icon_fit: CONTAIN_TRANSFORM.fit,
            icon_focal_x: CONTAIN_TRANSFORM.focalX,
            icon_focal_y: CONTAIN_TRANSFORM.focalY,
            icon_zoom: CONTAIN_TRANSFORM.zoom,
            icon_rotation: CONTAIN_TRANSFORM.rotation,
            icon_media_revision: 0,
            display_order: this.groups.filter((row) => row.agency_id === input.agencyId).length,
            is_fallback: false
        };
        this.groups.push(group);
        this.agencies.find((row) => row.id === input.agencyId)!.layout_revision += 1;
        return { ...group };
    }
    async updateWikiGroup(input: UpdateWikiGroupInput) {
        const group = this.groups.find((row) => row.id === input.id);
        if (!group) throw Object.assign(new Error('栏目不存在'), { status: 404 });
        Object.assign(group, { code: input.code, name: input.name, color: input.color });
        return { ...group };
    }
    async deleteWikiGroup(input: DeleteWikiGroupInput) {
        const index = this.groups.findIndex((row) => row.id === input.id);
        if (index < 0) return null;
        const current = this.groups[index]!;
        if (current.icon_media_revision !== input.expectedRevision) {
            return { status: 'conflict' as const, revision: current.icon_media_revision };
        }
        const [group] = this.groups.splice(index, 1);
        this.members = this.members.filter((row) => row.group_id !== input.id);
        this.agencies.find((row) => row.id === group!.agency_id)!.layout_revision += 1;
        return { status: 'deleted' as const, group: { ...group! } };
    }
    async createWikiIdol(input: CreateWikiIdolInput): Promise<IdolRecord> {
        this.requireGroups(input.agencyId, input.groupIds);
        const agency = this.agencies.find((row) => row.id === input.agencyId)!;
        const idol: IdolWithAgencyRecord = {
            id: Math.max(0, ...this.idols.map((row) => row.id)) + 1,
            agency_id: input.agencyId,
            agency_code: agency.code,
            agency_name: agency.name_cn,
            agency_color: agency.color,
            name_cn: input.name,
            folder_name: input.folderName,
            color: input.color,
            wiki_enabled: input.wikiEnabled,
            display_order: this.idols.filter((row) => row.agency_id === input.agencyId).length,
            text_color: input.textColor,
            wiki_url: input.wikiUrl ?? null,
            avatar_object_key: null,
            avatar_fit: input.imageFit,
            avatar_focal_x: COVER_TRANSFORM.focalX,
            avatar_focal_y: COVER_TRANSFORM.focalY,
            avatar_zoom: COVER_TRANSFORM.zoom,
            avatar_rotation: COVER_TRANSFORM.rotation,
            avatar_media_revision: 0,
            entry_kind: input.entryKind ?? 'idol',
            entry_subtype: input.entryKind === 'story'
                ? input.entrySubtype ?? 'other'
                : null
        };
        this.idols.push(idol);
        for (const groupId of input.groupIds) this.addMember(idol, groupId);
        agency.layout_revision += 1;
        const { agency_code: _code, agency_name: _name, agency_color: _color, ...record } = idol;
        return { ...record };
    }
    async updateWikiIdol(input: UpdateWikiIdolInput): Promise<IdolRecord> {
        const idol = this.idols.find((row) =>
            row.id === input.id && !this.deletedIdolIds.has(row.id)
        );
        if (!idol) throw Object.assign(new Error('内容页不存在'), { status: 404 });
        this.requireGroups(idol.agency_id, input.groupIds);
        Object.assign(idol, {
            name_cn: input.name,
            color: input.color,
            text_color: input.textColor,
            wiki_url: input.wikiUrl === undefined ? idol.wiki_url : input.wikiUrl,
            avatar_fit: input.imageFit,
            wiki_enabled: input.wikiEnabled,
            entry_kind: input.entryKind ?? idol.entry_kind,
            entry_subtype: (input.entryKind ?? idol.entry_kind) === 'story'
                ? input.entrySubtype ?? idol.entry_subtype ?? 'other'
                : null
        });
        const requested = new Set(input.groupIds);
        const current = new Set(this.members
            .filter((row) => row.idol_id === input.id)
            .map((row) => row.group_id));
        const membershipChanged = input.groupIds.some((groupId) => !current.has(groupId)) ||
            [...current].some((groupId) => !requested.has(groupId));
        this.members = this.members.filter((row) =>
            row.idol_id !== input.id || requested.has(row.group_id)
        );
        for (const groupId of input.groupIds) {
            if (!current.has(groupId)) this.addMember(idol, groupId);
        }
        if (membershipChanged) {
            this.agencies.find((row) => row.id === idol.agency_id)!.layout_revision += 1;
        }
        const { agency_code: _code, agency_name: _name, agency_color: _color, ...record } = idol;
        return { ...record };
    }
    async deleteWikiIdol(input: DeleteWikiIdolInput) {
        const idol = this.idols.find((row) => row.id === input.id);
        if (!idol || this.deletedIdolIds.has(input.id)) return null;
        if (idol.avatar_media_revision !== input.expectedRevision) {
            return { status: 'conflict' as const, revision: idol.avatar_media_revision };
        }
        const affectedStories = this.stories.filter((story) => story.idol_id === input.id);
        const affectedCards = this.cards.filter((card) => card.idol_id === input.id);
        this.deletedIdolIds.add(input.id);
        idol.wiki_enabled = false;
        this.agencies.find((row) => row.id === idol.agency_id)!.layout_revision += 1;
        return {
            status: 'deleted' as const,
            idol: await this.findDeletedIdol(input.id),
            cardCount: affectedCards.length,
            storyCount: affectedStories.length
        };
    }
    private async findDeletedIdol(id: number): Promise<IdolRecord> {
        const row = this.idols.find((candidate) => candidate.id === id)!;
        const { agency_code: _code, agency_name: _name, agency_color: _color, ...idol } = row;
        return { ...idol };
    }
    private requireGroups(agencyId: number, groupIds: number[]) {
        if (new Set(groupIds).size !== groupIds.length || groupIds.some((id) =>
            !this.groups.some((group) => group.id === id && group.agency_id === agencyId)
        )) {
            throw Object.assign(new Error('栏目不存在或不属于该企划'), { status: 400 });
        }
    }
    private addMember(idol: IdolWithAgencyRecord, groupId: number) {
        this.members.push({
            agency_id: idol.agency_id,
            group_id: groupId,
            idol_id: idol.id,
            display_order: this.members.filter((row) => row.group_id === groupId).length
        });
    }
    async setAgencyIconObjectKey(agencyId: number, objectKey: string | null) {
        const agency = this.agencies.find((row) => row.id === agencyId);
        if (agency) {
            agency.icon_object_key = objectKey;
            agency.icon_media_revision += 1;
        }
    }
    async setIdolAvatarObjectKey(idolId: number, objectKey: string | null) {
        const idol = this.idols.find((row) => row.id === idolId);
        if (idol) {
            idol.avatar_object_key = objectKey;
            idol.avatar_media_revision += 1;
        }
    }
    async saveAgencyIconMedia(input: SaveWikiEntityMediaInput) {
        const agency = this.agencies.find((row) => row.id === input.id);
        if (!agency) throw Object.assign(new Error('企划不存在'), { status: 404 });
        if (agency.icon_media_revision !== input.expectedRevision) {
            return { status: 'conflict' as const, revision: agency.icon_media_revision };
        }
        const previousObjectKey = agency.icon_object_key;
        Object.assign(agency, {
            icon_object_key: input.objectKey,
            icon_fit: input.transform.fit,
            icon_focal_x: input.transform.focalX,
            icon_focal_y: input.transform.focalY,
            icon_zoom: input.transform.zoom,
            icon_rotation: input.transform.rotation,
            icon_media_revision: agency.icon_media_revision + 1
        });
        return {
            status: 'saved' as const,
            revision: agency.icon_media_revision,
            previousObjectKey
        };
    }
    async saveWikiGroupIconMedia(input: SaveWikiEntityMediaInput) {
        const group = this.groups.find((row) => row.id === input.id);
        if (!group) throw Object.assign(new Error('栏目不存在'), { status: 404 });
        if (group.icon_media_revision !== input.expectedRevision) {
            return { status: 'conflict' as const, revision: group.icon_media_revision };
        }
        const previousObjectKey = group.icon_object_key;
        Object.assign(group, {
            icon_object_key: input.objectKey,
            icon_fit: input.transform.fit,
            icon_focal_x: input.transform.focalX,
            icon_focal_y: input.transform.focalY,
            icon_zoom: input.transform.zoom,
            icon_rotation: input.transform.rotation,
            icon_media_revision: group.icon_media_revision + 1
        });
        return {
            status: 'saved' as const,
            revision: group.icon_media_revision,
            previousObjectKey
        };
    }
    async saveIdolAvatarMedia(input: SaveWikiEntityMediaInput) {
        const idol = this.idols.find((row) => row.id === input.id);
        if (!idol) throw Object.assign(new Error('内容页不存在'), { status: 404 });
        if (idol.avatar_media_revision !== input.expectedRevision) {
            return { status: 'conflict' as const, revision: idol.avatar_media_revision };
        }
        const previousObjectKey = idol.avatar_object_key;
        Object.assign(idol, {
            avatar_object_key: input.objectKey,
            avatar_fit: input.transform.fit,
            avatar_focal_x: input.transform.focalX,
            avatar_focal_y: input.transform.focalY,
            avatar_zoom: input.transform.zoom,
            avatar_rotation: input.transform.rotation,
            avatar_media_revision: idol.avatar_media_revision + 1
        });
        return {
            status: 'saved' as const,
            revision: idol.avatar_media_revision,
            previousObjectKey
        };
    }
    async ensureWikiCategory(agencyId: number, idolId: number, name: string, storageSlug: string) {
        let category = this.categories.find((row) =>
            row.agency_id === agencyId && row.idol_id === idolId && row.name === name
        );
        if (!category) {
            const shared = this.categories.find((row) =>
                row.agency_id === agencyId && row.name === name
            );
            category = {
                id: shared?.id ?? Math.max(0, ...this.categories.map((row) => row.id)) + 1,
                agency_id: agencyId,
                idol_id: idolId,
                name,
                storage_slug: shared?.storage_slug ?? storageSlug,
                background_eligible: shared?.background_eligible ?? false,
                display_order: this.categories.filter((row) => row.idol_id === idolId).length,
                show_when_empty: true
            };
            this.categories.push(category);
        }
        const { idol_id: _idolId, ...record } = category;
        return { ...record };
    }
    async updateWikiCategory(input: UpdateWikiCategoryInput) {
        const assigned = this.categories.find((row) =>
            row.id === input.id && row.agency_id === input.agencyId &&
            row.idol_id === input.idolId
        );
        if (!assigned) return null;
        if (assigned.name !== input.expectedName) {
            return { status: 'conflict' as const, currentName: assigned.name };
        }
        if (this.categories.some((row) =>
            row.agency_id === input.agencyId && row.id !== input.id && row.name === input.name
        )) {
            throw Object.assign(new Error('UNIQUE constraint failed: wiki_categories.name'), {
                status: 409
            });
        }
        for (const category of this.categories.filter((row) =>
            row.agency_id === input.agencyId && row.id === input.id
        )) {
            category.name = input.name;
        }
        const { idol_id: _idolId, ...record } = assigned;
        return { status: 'saved' as const, category: { ...record } };
    }
    async deleteWikiCategoryAssociation(agencyId: number, idolId: number, name: string) {
        const category = (await this.listWikiCategories(agencyId, idolId))
            .find((row) => row.name === name) ?? null;
        this.categories = this.categories.filter((row) =>
            !(row.agency_id === agencyId && row.idol_id === idolId && row.name === name)
        );
        return category;
    }
    async saveWikiLayout(input: WikiLayoutInput) {
        const agency = this.agencies.find((row) => row.id === input.agencyId);
        if (!agency) throw Object.assign(new Error('企划不存在'), { status: 404 });
        if (agency.layout_revision !== input.expectedRevision) {
            return { status: 'conflict' as const, revision: agency.layout_revision };
        }
        this.members = this.members.filter((row) => row.agency_id !== input.agencyId);
        for (const group of input.groups) {
            group.idolIds.forEach((idolId, displayOrder) => this.members.push({
                agency_id: input.agencyId,
                group_id: group.id,
                idol_id: idolId,
                display_order: displayOrder
            }));
        }
        agency.layout_revision += 1;
        return { status: 'saved' as const, revision: agency.layout_revision };
    }
    async listStories(agencyCode: string, idolId: number) {
        const agencyIds = new Set(this.agencies.filter((row) => row.code === agencyCode).map((row) => row.id));
        const idolIds = new Set(this.idols.filter((row) => agencyIds.has(row.agency_id)).map((row) => row.id));
        return this.stories.filter((row) =>
            row.idol_id === idolId && idolIds.has(row.idol_id) &&
            !this.deletedIdolIds.has(row.idol_id)
        ).map(cloneStory);
    }
    async listStoryCards(agencyCode: string, idolId: number) {
        const agencyIds = new Set(this.agencies.filter((row) =>
            row.code === agencyCode
        ).map((row) => row.id));
        const idolIds = new Set(this.idols.filter((row) =>
            agencyIds.has(row.agency_id)
        ).map((row) => row.id));
        return this.cards.filter((row) =>
            row.idol_id === idolId && idolIds.has(row.idol_id) &&
            !this.deletedIdolIds.has(row.idol_id)
        ).map((row) => ({ ...row }));
    }
    async listStoryContentTypes() {
        return this.contentTypes.map((option) => ({ ...option }));
    }
    async listStorySourcePlatforms() {
        return this.sourcePlatforms.map((option) => ({ ...option }));
    }
    async createStoryContentType(input: WikiStoryContentTypeInput) {
        const option: WikiStoryContentTypeRecord = {
            id: Math.max(0, ...this.contentTypes.map((candidate) => candidate.id)) + 1,
            name: input.name,
            icon_name: input.iconName,
            description: input.description,
            display_order: this.contentTypes.length,
            is_active: input.isActive,
            revision: 0
        };
        this.contentTypes.push(option);
        return { ...option };
    }
    async updateStoryContentType(
        id: number,
        expectedRevision: number,
        input: WikiStoryContentTypeInput
    ) {
        const option = this.contentTypes.find((candidate) => candidate.id === id);
        if (!option) return null;
        if (option.revision !== expectedRevision) {
            return { status: 'conflict' as const, revision: option.revision };
        }
        Object.assign(option, {
            name: input.name,
            icon_name: input.iconName,
            description: input.description,
            is_active: input.isActive,
            revision: option.revision + 1
        });
        return { status: 'saved' as const, option: { ...option } };
    }
    async deleteStoryContentType(id: number) {
        const index = this.contentTypes.findIndex((candidate) => candidate.id === id);
        if (index < 0) return { status: 'not-found' as const };
        if (this.stories.some((story) => story.content_type_id === id)) {
            return { status: 'in-use' as const };
        }
        this.contentTypes.splice(index, 1);
        return { status: 'deleted' as const };
    }
    async createStorySourcePlatform(input: WikiStorySourcePlatformInput) {
        const option: WikiStorySourcePlatformRecord = {
            id: Math.max(0, ...this.sourcePlatforms.map((candidate) => candidate.id)) + 1,
            name: input.name,
            homepage_url: input.homepageUrl,
            description: input.description,
            display_order: this.sourcePlatforms.length,
            is_active: input.isActive,
            revision: 0
        };
        this.sourcePlatforms.push(option);
        return { ...option };
    }
    async updateStorySourcePlatform(
        id: number,
        expectedRevision: number,
        input: WikiStorySourcePlatformInput
    ) {
        const option = this.sourcePlatforms.find((candidate) => candidate.id === id);
        if (!option) return null;
        if (option.revision !== expectedRevision) {
            return { status: 'conflict' as const, revision: option.revision };
        }
        Object.assign(option, {
            name: input.name,
            homepage_url: input.homepageUrl,
            description: input.description,
            is_active: input.isActive,
            revision: option.revision + 1
        });
        return { status: 'saved' as const, option: { ...option } };
    }
    async deleteStorySourcePlatform(id: number) {
        const index = this.sourcePlatforms.findIndex((candidate) => candidate.id === id);
        if (index < 0) return { status: 'not-found' as const };
        if (this.stories.some((story) => story.source_platform_id === id)) {
            return { status: 'in-use' as const };
        }
        this.sourcePlatforms.splice(index, 1);
        return { status: 'deleted' as const };
    }
    async listStoryCoverAssets(agencyId: number) {
        return this.coverAssets.filter((asset) => asset.agency_id === agencyId)
            .map((asset) => ({
                ...asset,
                usage_count: new Set(this.stories.filter((story) =>
                    story.cover_asset_id === asset.id
                ).map((story) => story.card_id)).size
            }));
    }
    async findStoryCoverAssetById(id: number) {
        const asset = this.coverAssets.find((candidate) => candidate.id === id);
        if (!asset) return null;
        return {
            ...asset,
            usage_count: new Set(this.stories.filter((story) =>
                story.cover_asset_id === asset.id
            ).map((story) => story.card_id)).size
        };
    }
    async createStoryCoverAsset(input: CreateWikiStoryCoverAssetInput) {
        if (!this.agencies.some((agency) => agency.id === input.agencyId)) {
            throw Object.assign(new Error('企划不存在'), { status: 404 });
        }
        if (this.coverAssets.some((asset) =>
            asset.agency_id === input.agencyId && asset.name === input.name
        )) {
            throw Object.assign(new Error('UNIQUE constraint failed'), { status: 409 });
        }
        const asset: WikiStoryCoverAssetRecord = {
            id: Math.max(0, ...this.coverAssets.map((candidate) => candidate.id)) + 1,
            agency_id: input.agencyId,
            name: input.name,
            object_key: input.objectKey,
            presentation_policy: input.presentationPolicy,
            display_order: this.coverAssets.filter((candidate) =>
                candidate.agency_id === input.agencyId
            ).length,
            is_active: true,
            revision: 0,
            usage_count: 0
        };
        this.coverAssets.push(asset);
        return { ...asset };
    }
    async updateStoryCoverAsset(input: UpdateWikiStoryCoverAssetInput) {
        const asset = this.coverAssets.find((candidate) =>
            candidate.id === input.id && candidate.agency_id === input.agencyId
        );
        if (!asset) return null;
        if (asset.revision !== input.expectedRevision) {
            return { status: 'conflict' as const, revision: asset.revision };
        }
        const previousObjectKey = asset.object_key === input.objectKey
            ? null
            : asset.object_key;
        Object.assign(asset, {
            name: input.name,
            object_key: input.objectKey,
            presentation_policy: input.presentationPolicy,
            is_active: input.isActive,
            revision: asset.revision + 1
        });
        for (const card of this.cards.filter((candidate) =>
            candidate.cover_asset_id === asset.id
        )) {
            card.cover_asset_name = asset.name;
            card.cover_asset_object_key = asset.object_key;
            card.cover_asset_revision = asset.revision;
            card.cover_asset_presentation_policy = asset.presentation_policy;
        }
        for (const story of this.stories.filter((candidate) =>
            candidate.cover_asset_id === asset.id
        )) {
            Object.assign(story, cardFromStory(
                this.cards.find((card) => card.card_id === story.card_id)!
            ));
        }
        return {
            status: 'saved' as const,
            asset: { ...asset },
            previousObjectKey
        };
    }
    async deleteStoryCoverAsset(id: number) {
        const index = this.coverAssets.findIndex((candidate) => candidate.id === id);
        if (index < 0) return { status: 'not-found' as const };
        const usageCount = this.cards.filter((card) =>
            card.cover_asset_id === id
        ).length;
        if (usageCount) return { status: 'in-use' as const, usageCount };
        const [asset] = this.coverAssets.splice(index, 1);
        return { status: 'deleted' as const, objectKey: asset!.object_key };
    }
    async sampleStory(agencyCode: string, _categories: readonly string[]) {
        const story = this.samples.get(agencyCode) ?? null;
        return story && !this.deletedIdolIds.has(story.idol_id) ? story : null;
    }
    async sampleWikiBackground() {
        for (const [agencyCode, story] of this.samples) {
            if (!story) continue;
            if (story.cover_asset_presentation_policy === 'contain') continue;
            const agency = this.agencies.find((row) => row.code === agencyCode);
            const idol = this.idols.find((row) => row.id === story.idol_id);
            if (agency && idol && !this.deletedIdolIds.has(idol.id)) {
                return {
                    ...story,
                    agency_id: agency.id,
                    agency_code: agency.code,
                    agency_name: agency.name_cn,
                    idol_name: idol.name_cn,
                    idol_folder_name: idol.folder_name
                };
            }
        }
        return null;
    }
    async insertStoryReturningId(input: NewStoryInput) {
        const [id] = await this.insertStoryBatchReturningIds({
            agencyCode: input.agencyCode,
            idolId: input.idolId,
            category: input.category,
            cardName: input.cardName,
            subtitle: input.subtitle,
            imageFile: input.imageFile,
            coverAssetId: input.coverAssetId ?? null,
            imageTransform: input.imageTransform,
            links: [{
                upName: input.upName,
                videoTitle: input.videoTitle,
                url: input.url,
                contentTypeId: input.contentTypeId,
                sourcePlatformId: input.sourcePlatformId
            }]
        });
        return id!;
    }
    async insertStoryBatchReturningIds(input: NewStoryBatchInput) {
        if (this.failNextInsert) {
            this.failNextInsert = false;
            throw new Error('injected insert commit failure');
        }
        const existingCard = this.cards.find((row) =>
            row.idol_id === input.idolId && row.category === input.category &&
            row.card_name === input.cardName
        );
        const hasImageConflict = Boolean(input.imageFile) &&
            input.imageFile !== existingCard?.image_file;
        const hasCoverAssetConflict = input.coverAssetId !== undefined &&
            input.coverAssetId !== existingCard?.cover_asset_id;
        const hasSubtitleConflict = Boolean(input.subtitle) &&
            input.subtitle !== (existingCard?.subtitle ?? '');
        const hasTransformConflict = Boolean(input.imageFile) && existingCard !== undefined && (
            input.imageTransform.fit !== existingCard.image_fit ||
            input.imageTransform.focalX !== existingCard.image_focal_x ||
            input.imageTransform.focalY !== existingCard.image_focal_y ||
            input.imageTransform.zoom !== existingCard.image_zoom ||
            input.imageTransform.rotation !== existingCard.image_rotation
        );
        if (existingCard && (hasImageConflict || hasCoverAssetConflict ||
            hasSubtitleConflict || hasTransformConflict)) {
            throw Object.assign(
                new Error('该卡片已存在，请在卡片编辑中更新图片或副标题'),
                { status: 409 }
            );
        }
        const card: StoryCardRecord = existingCard ?? {
            card_id: this.nextCardId,
            idol_id: input.idolId,
            category: input.category,
            card_name: input.cardName,
            subtitle: input.subtitle,
            image_file: input.imageFile,
            cover_asset_id: input.coverAssetId ?? null,
            cover_asset_name: this.coverAssets.find((asset) =>
                asset.id === input.coverAssetId
            )?.name ?? null,
            cover_asset_object_key: this.coverAssets.find((asset) =>
                asset.id === input.coverAssetId
            )?.object_key ?? null,
            cover_asset_revision: this.coverAssets.find((asset) =>
                asset.id === input.coverAssetId
            )?.revision ?? null,
            cover_asset_presentation_policy: this.coverAssets.find((asset) =>
                asset.id === input.coverAssetId
            )?.presentation_policy ?? null,
            image_fit: input.imageTransform.fit,
            image_focal_x: input.imageTransform.focalX,
            image_focal_y: input.imageTransform.focalY,
            image_zoom: input.imageTransform.zoom,
            image_rotation: input.imageTransform.rotation,
            image_media_revision: 0
        };
        const firstId = this.nextId;
        const rows = input.links.map((link, index): StoryRecord => ({
            id: firstId + index,
            ...card,
            up_name: link.upName,
            video_title: link.videoTitle,
            url: link.url,
            content_type_id: link.contentTypeId,
            content_type_name: this.contentTypes.find((option) =>
                option.id === link.contentTypeId
            )?.name ?? '',
            content_type_icon_name: this.contentTypes.find((option) =>
                option.id === link.contentTypeId
            )?.icon_name ?? 'link-2',
            source_platform_id: link.sourcePlatformId,
            source_platform_name: this.sourcePlatforms.find((option) =>
                option.id === link.sourcePlatformId
            )?.name ?? '',
        }));
        if (!existingCard) this.cards.push(card);
        this.stories.push(...rows);
        this.nextId += rows.length;
        if (!existingCard) this.nextCardId += 1;
        return rows.map((row) => row.id);
    }
    async addStoryCardSources(input: AddStoryCardSourcesInput) {
        if (!input.links.length || input.links.length > 20) {
            throw Object.assign(new Error('剧情卡片需要 1 至 20 个来源'), { status: 400 });
        }
        const card = await this.findStoryCardById(
            input.agencyCode,
            input.idolId,
            input.cardId
        );
        if (!card) throw Object.assign(new Error('剧情卡片不存在'), { status: 404 });
        if (card.image_media_revision !== input.expectedRevision) {
            return { status: 'conflict' as const, revision: card.image_media_revision };
        }
        const ids = input.links.map((link, index) => this.nextId + index);
        this.stories.push(...input.links.map((link, index): MemoryStoryRecord => ({
            ...card,
            id: ids[index]!,
            up_name: link.upName,
            video_title: link.videoTitle,
            url: link.url,
            content_type_id: link.contentTypeId,
            content_type_name: this.contentTypes.find((option) =>
                option.id === link.contentTypeId
            )?.name ?? '',
            content_type_icon_name: this.contentTypes.find((option) =>
                option.id === link.contentTypeId
            )?.icon_name ?? 'link-2',
            source_platform_id: link.sourcePlatformId,
            source_platform_name: this.sourcePlatforms.find((option) =>
                option.id === link.sourcePlatformId
            )?.name ?? '',
            legacy_image_file: null
        })));
        this.nextId += input.links.length;
        return { status: 'added' as const, ids, revision: input.expectedRevision };
    }
    async setStoryImage(_agencyCode: string, id: number, imageFile: string) {
        const row = this.stories.find((candidate) => candidate.id === id);
        if (!row) return;
        const card = this.cards.find((candidate) => candidate.card_id === row.card_id);
        if (card) {
            card.image_file = imageFile;
            card.cover_asset_id = null;
            card.cover_asset_name = null;
            card.cover_asset_object_key = null;
            card.cover_asset_revision = null;
            card.image_media_revision += 1;
        }
        for (const candidate of this.stories.filter((item) => item.card_id === row.card_id)) {
            if (card) Object.assign(candidate, cardFromStory(card));
        }
    }
    async findFirstStoryByCard(_agencyCode: string, idolId: number, category: string, cardName: string) {
        if (this.deletedIdolIds.has(idolId)) return null;
        const row = this.stories.find((candidate) =>
            candidate.idol_id === idolId && candidate.category === category && candidate.card_name === cardName
        );
        return row ? cloneStory(row) : null;
    }
    async findStoryById(_agencyCode: string, idolId: number, id: number) {
        if (this.deletedIdolIds.has(idolId)) return null;
        const row = this.stories.find((candidate) =>
            candidate.idol_id === idolId && candidate.id === id
        );
        return row ? cloneStory(row) : null;
    }
    async findStoryCardById(agencyCode: string, idolId: number, cardId: number) {
        if (this.deletedIdolIds.has(idolId)) return null;
        const agency = this.agencies.find((candidate) => candidate.code === agencyCode);
        const idol = this.idols.find((candidate) =>
            candidate.id === idolId && candidate.agency_id === agency?.id
        );
        if (!idol) return null;
        const row = this.cards.find((candidate) =>
            candidate.idol_id === idolId && candidate.card_id === cardId
        );
        return row ? { ...row } : null;
    }
    async updateStoryCard(input: UpdateStoryCardInput) {
        if (this.failNextUpdate) {
            this.failNextUpdate = false;
            throw new Error('injected update commit failure');
        }
        const row = await this.findStoryCardById(input.agencyCode, input.idolId, input.id);
        if (!row) throw Object.assign(new Error('剧情卡片不存在'), { status: 404 });
        if (row.image_media_revision !== input.expectedRevision) {
            return { status: 'conflict' as const, revision: row.image_media_revision };
        }
        const agency = this.agencies.find((candidate) => candidate.code === input.agencyCode)!;
        const category = this.categories.find((candidate) =>
            candidate.id === input.categoryId && candidate.agency_id === agency.id &&
            candidate.idol_id === input.idolId
        );
        if (!category) {
            throw Object.assign(new Error('分类不属于所选内容页'), { status: 400 });
        }
        if (this.cards.some((candidate) =>
            candidate.card_id !== input.id && candidate.idol_id === input.idolId &&
            candidate.category === category.name && candidate.card_name === input.cardName
        )) {
            throw Object.assign(new Error('UNIQUE constraint failed: wiki_story_cards'), {
                status: 409
            });
        }
        for (const cardRow of this.cards.filter((candidate) =>
            candidate.card_id === input.id
        )) {
            cardRow.category = category.name;
            cardRow.card_name = input.cardName;
            cardRow.subtitle = input.subtitle;
            cardRow.image_file = input.imageFile;
            cardRow.cover_asset_id = input.coverAssetId ?? null;
            const coverAsset = this.coverAssets.find((asset) =>
                asset.id === cardRow.cover_asset_id
            );
            cardRow.cover_asset_name = coverAsset?.name ?? null;
            cardRow.cover_asset_object_key = coverAsset?.object_key ?? null;
            cardRow.cover_asset_revision = coverAsset?.revision ?? null;
            cardRow.cover_asset_presentation_policy =
                coverAsset?.presentation_policy ?? null;
            cardRow.image_fit = input.imageTransform.fit;
            cardRow.image_focal_x = input.imageTransform.focalX;
            cardRow.image_focal_y = input.imageTransform.focalY;
            cardRow.image_zoom = input.imageTransform.zoom;
            cardRow.image_rotation = input.imageTransform.rotation;
            cardRow.image_media_revision += 1;
        }
        const updatedCard = this.cards.find((candidate) => candidate.card_id === input.id)!;
        for (const story of this.stories.filter((candidate) =>
            candidate.card_id === input.id
        )) {
            Object.assign(story, cardFromStory(updatedCard));
        }
        return { status: 'saved' as const, revision: input.expectedRevision + 1 };
    }
    async deleteStoryLink(input: DeleteStoryLinkInput) {
        const agency = this.agencies.find((candidate) => candidate.code === input.agencyCode);
        const idol = this.idols.find((candidate) =>
            candidate.id === input.idolId && candidate.agency_id === agency?.id
        );
        if (!idol) return null;
        const index = this.stories.findIndex((candidate) =>
            candidate.idol_id === input.idolId && candidate.id === input.id
        );
        if (index < 0) return null;
        const current = this.stories[index]!;
        if (current.image_media_revision !== input.expectedRevision) {
            return { status: 'conflict' as const, revision: current.image_media_revision };
        }
        const [story] = this.stories.splice(index, 1);
        const candidates = [story!.legacy_image_file];
        const referenced = new Set(this.stories
            .filter((candidate) => candidate.idol_id === input.idolId)
            .flatMap((candidate) => [candidate.image_file, candidate.legacy_image_file])
            .filter((value): value is string => typeof value === 'string' && Boolean(value)));
        return {
            status: 'deleted' as const,
            cardDeleted: false,
            revision: current.image_media_revision,
            cleanupImageFiles: [...new Set(candidates.filter((value): value is string =>
                typeof value === 'string' && Boolean(value) && !referenced.has(value)
            ))]
        };
    }
    async updateStory(input: UpdateStoryInput) {
        await this.applyUpdate(input);
    }
    async updateStoryAndRenameGroup(input: {
        story: UpdateStoryInput;
        rename?: {
            oldCategory: string;
            oldCardName: string;
            category: string;
            cardName: string;
            subtitle: string;
        };
    }) {
        if (this.failNextUpdate) {
            this.failNextUpdate = false;
            throw new Error('injected update commit failure');
        }
        await this.applyUpdate(input.story);
    }
    async renameStoryGroup(input: {
        agencyCode: string;
        idolId: number;
        oldCategory: string;
        oldCardName: string;
        category: string;
        cardName: string;
        subtitle: string;
        excludeId: number;
    }) {
        const card = this.cards.find((row) =>
            row.idol_id === input.idolId && row.category === input.oldCategory &&
            row.card_name === input.oldCardName
        );
        if (card) {
            card.category = input.category;
            card.card_name = input.cardName;
            card.subtitle = input.subtitle;
        }
        for (const row of this.stories) {
            if (row.id !== input.excludeId && row.idol_id === input.idolId &&
                row.category === input.oldCategory && row.card_name === input.oldCardName) {
                row.category = input.category;
                row.card_name = input.cardName;
                row.subtitle = input.subtitle;
            }
        }
    }
    async listStoryGroupForDelete(_agencyCode: string, idolId: number, category: string, cardName: string) {
        return this.stories.filter((row) =>
            row.idol_id === idolId && row.category === category && row.card_name === cardName
        ).map(cloneStory);
    }
    async deleteStoryGroup(_agencyCode: string, idolId: number, category: string, cardName: string) {
        if (this.failNextDeleteStory) {
            this.failNextDeleteStory = false;
            throw new Error('injected delete commit failure');
        }
        this.stories = this.stories.filter((row) =>
            !(row.idol_id === idolId && row.category === category && row.card_name === cardName)
        );
        this.cards = this.cards.filter((row) =>
            !(row.idol_id === idolId && row.category === category && row.card_name === cardName)
        );
    }
    async listCategoryImages(_agencyCode: string, idolId: number, category: string) {
        return this.cards.filter((row) => row.idol_id === idolId && row.category === category)
            .map((row) => ({ image_file: row.image_file }));
    }
    async deleteCategory(_agencyCode: string, idolId: number, category: string) {
        if (this.failNextDeleteCategory) {
            this.failNextDeleteCategory = false;
            throw new Error('injected category commit failure');
        }
        this.stories = this.stories.filter((row) => !(row.idol_id === idolId && row.category === category));
        this.cards = this.cards.filter((row) => !(row.idol_id === idolId && row.category === category));
    }

    seedStory(
        input: Partial<MemoryStoryRecord> &
            Pick<StoryRecord, 'idol_id' | 'category' | 'card_name'>
    ) {
        const row: MemoryStoryRecord = {
            id: input.id ?? this.nextId++,
            card_id: input.card_id ?? this.stories.find((candidate) =>
                candidate.idol_id === input.idol_id && candidate.category === input.category &&
                candidate.card_name === input.card_name
            )?.card_id ?? this.nextCardId++,
            idol_id: input.idol_id,
            category: input.category,
            card_name: input.card_name,
            up_name: input.up_name ?? 'fixture-up',
            video_title: input.video_title ?? 'fixture-title',
            url: input.url ?? 'https://www.bilibili.com/video/BV1xx411c7mD',
            content_type_id: input.content_type_id ?? 1,
            content_type_name: input.content_type_name ?? '剧情',
            content_type_icon_name: input.content_type_icon_name ?? 'book-open-text',
            source_platform_id: input.source_platform_id ?? 1,
            source_platform_name: input.source_platform_name ?? 'Bilibili',
            subtitle: input.subtitle ?? '',
            image_file: input.image_file ?? null,
            cover_asset_id: input.cover_asset_id ?? null,
            cover_asset_name: input.cover_asset_name ?? null,
            cover_asset_object_key: input.cover_asset_object_key ?? null,
            cover_asset_revision: input.cover_asset_revision ?? null,
            cover_asset_presentation_policy:
                input.cover_asset_presentation_policy ?? null,
            image_fit: input.image_fit ?? COVER_TRANSFORM.fit,
            image_focal_x: input.image_focal_x ?? COVER_TRANSFORM.focalX,
            image_focal_y: input.image_focal_y ?? COVER_TRANSFORM.focalY,
            image_zoom: input.image_zoom ?? COVER_TRANSFORM.zoom,
            image_rotation: input.image_rotation ?? COVER_TRANSFORM.rotation,
            image_media_revision: input.image_media_revision ?? 0,
            legacy_image_file: input.legacy_image_file ?? null
        };
        this.nextId = Math.max(this.nextId, row.id + 1);
        this.nextCardId = Math.max(this.nextCardId, row.card_id + 1);
        if (!this.cards.some((card) => card.card_id === row.card_id)) {
            this.cards.push(cardFromStory(row));
        }
        this.stories.push(row);
        return row;
    }

    addAgencyWithIdol(agency: AgencyRecord, idol: IdolWithAgencyRecord) {
        this.agencies.push({ ...agency });
        this.idols.push({ ...idol });
    }

    private async applyUpdate(input: UpdateStoryInput) {
        if (this.failNextUpdate) {
            this.failNextUpdate = false;
            throw new Error('injected update commit failure');
        }
        const row = this.stories.find((candidate) => candidate.id === input.id);
        if (!row) throw new Error('story not found');
        if (row.image_media_revision !== input.expectedMediaRevision) {
            throw Object.assign(new Error('剧情图片已被其他编辑更新'), {
                status: 409,
                revision: row.image_media_revision
            });
        }
        const card = this.cards.find((candidate) => candidate.card_id === row.card_id)!;
        card.idol_id = input.idolId;
        card.category = input.category;
        card.card_name = input.cardName;
        card.subtitle = input.subtitle;
        card.image_file = input.imageFile;
        card.cover_asset_id = input.coverAssetId ?? null;
            const coverAsset = this.coverAssets.find((asset) =>
            asset.id === card.cover_asset_id
            );
        card.cover_asset_name = coverAsset?.name ?? null;
        card.cover_asset_object_key = coverAsset?.object_key ?? null;
        card.cover_asset_revision = coverAsset?.revision ?? null;
        card.cover_asset_presentation_policy =
            coverAsset?.presentation_policy ?? null;
        card.image_fit = input.imageTransform.fit;
        card.image_focal_x = input.imageTransform.focalX;
        card.image_focal_y = input.imageTransform.focalY;
        card.image_zoom = input.imageTransform.zoom;
        card.image_rotation = input.imageTransform.rotation;
        card.image_media_revision += 1;
        for (const cardRow of this.stories.filter((candidate) =>
            candidate.card_id === row.card_id
        )) {
            Object.assign(cardRow, cardFromStory(card));
        }
        row.up_name = input.upName;
        row.video_title = input.videoTitle;
        row.url = input.url;
        row.content_type_id = input.contentTypeId;
        row.content_type_name = this.contentTypes.find((option) =>
            option.id === input.contentTypeId
        )?.name ?? '';
        row.content_type_icon_name = this.contentTypes.find((option) =>
            option.id === input.contentTypeId
        )?.icon_name ?? 'link-2';
        row.source_platform_id = input.sourcePlatformId;
        row.source_platform_name = this.sourcePlatforms.find((option) =>
            option.id === input.sourcePlatformId
        )?.name ?? '';
    }
}

function stored(body: Uint8Array, contentType = 'application/octet-stream'): StoredObject {
    return {
        body: Uint8Array.from(body),
        size: body.byteLength,
        contentType,
        etag: `"fixture-${body.byteLength}"`,
        uploadedAt: new Date('2026-07-21T00:00:00Z')
    };
}

export class MemoryObjectStorage implements ObjectStorage {
    objects = new Map<string, StoredObject>();
    gets: string[] = [];
    puts: string[] = [];
    deletes: string[] = [];
    copies: Array<{ source: string; destination: string }> = [];
    lists: string[] = [];
    deletedPrefixes: string[] = [];
    failNextPutAfterWrite = false;
    failDeleteKeys = new Set<string>();
    publicReadUrlBase: string | null = null;
    publicReads: string[] = [];

    async get(key: string) {
        this.gets.push(key);
        const value = this.objects.get(key);
        return value ? { ...value, body: Uint8Array.from(value.body) } : null;
    }
    async createPublicReadUrl(key: string) {
        this.publicReads.push(key);
        if (!this.publicReadUrlBase || !this.objects.has(key)) return null;
        return `${this.publicReadUrlBase}/${key.split('/').map(encodeURIComponent).join('/')}`;
    }
    async put(key: string, body: Uint8Array, options?: PutObjectOptions) {
        this.puts.push(key);
        const value = stored(body, options?.contentType ?? 'application/octet-stream');
        this.objects.set(key, value);
        if (this.failNextPutAfterWrite) {
            this.failNextPutAfterWrite = false;
            throw new Error('injected partial object write');
        }
        return { ...value, body: Uint8Array.from(value.body) };
    }
    async delete(key: string) {
        this.deletes.push(key);
        if (this.failDeleteKeys.has(key)) throw new Error('injected cleanup failure');
        this.objects.delete(key);
    }
    async exists(key: string) { return this.objects.has(key); }
    async copy(sourceKey: string, destinationKey: string) {
        const source = this.objects.get(sourceKey);
        if (!source) throw new Error('source not found');
        this.copies.push({ source: sourceKey, destination: destinationKey });
        this.objects.set(destinationKey, { ...source, body: Uint8Array.from(source.body) });
    }
    async move(sourceKey: string, destinationKey: string) {
        await this.copy(sourceKey, destinationKey);
        await this.delete(sourceKey);
    }
    async list(prefix: string) {
        this.lists.push(prefix);
        return [...this.objects.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({
            key,
            size: value.size,
            etag: value.etag
        }));
    }
    async deletePrefix(prefix: string) {
        this.deletedPrefixes.push(prefix);
        for (const key of [...this.objects.keys()]) if (key.startsWith(prefix)) this.objects.delete(key);
    }

    seed(key: string, body = new Uint8Array([1, 2, 3]), contentType = 'image/webp') {
        this.objects.set(key, stored(body, contentType));
    }
}

export class FixtureImageProcessor implements ImageProcessor {
    validations: Uint8Array[] = [];

    async validate(body: Uint8Array): Promise<ImageInfo> {
        this.validations.push(Uint8Array.from(body));
        const marker = new TextDecoder().decode(body);
        if (marker === 'broken') throw new Error('decode failed');
        const format = marker === 'forged-png' ? 'jpeg' : marker === 'valid-jpeg' ? 'jpeg' : 'png';
        return { format, width: 1, height: 1, contentType: `image/${format}` };
    }
    async toWebp(body: Uint8Array) {
        if (new TextDecoder().decode(body) === 'convert-failure') throw new Error('conversion failed');
        return new Uint8Array([0x57, 0x45, 0x42, 0x50]);
    }
    async thumbnailPng() { return new Uint8Array([1]); }
    async resizeJpeg() { return new Uint8Array([1]); }
}

export class FixtureUploadParser implements UploadParser {
    next: ParsedUpload = { fields: {}, files: {} };
    calls: Array<{ maxBytes: number; fileFields: readonly string[] }> = [];

    async parse(_request: Request, options: { maxBytes: number; fileFields: readonly string[] }) {
        this.calls.push(options);
        return this.next;
    }
}

export interface WikiFixture {
    app: ReturnType<typeof createHonoApp>;
    services: RuntimeServices;
    story: MemoryStoryRepository;
    storage: MemoryObjectStorage;
    images: FixtureImageProcessor;
    uploads: FixtureUploadParser;
    staticRequests: string[];
    setFetch(fetchImpl: typeof globalThis.fetch): void;
    auth(role?: string, csrf?: string): Promise<{ token: string; csrf: string }>;
    authHeaders(role?: string, csrf?: string): Promise<Record<string, string>>;
    setUpload(upload: ParsedUpload): void;
}

export function createWikiFixture(): WikiFixture {
    const story = new MemoryStoryRepository();
    const storage = new MemoryObjectStorage();
    const images = new FixtureImageProcessor();
    const uploads = new FixtureUploadParser();
    const tokens = new HmacBackofficeTokenService('wiki-contract-secret-that-is-longer-than-thirty-two-bytes');
    const staticRequests: string[] = [];
    const services: RuntimeServices = {
        story,
        storage,
        images,
        uploads,
        backofficeTokens: tokens,
        config: { storyMaxUploadBytes: 1024 },
        staticAssets: {
            async fetch(request: Request) {
                const path = new URL(request.url).pathname;
                staticRequests.push(path);
                if (path === '/index.html') {
                    return new Response('<!doctype html><html><head><title>IMS Main Site</title></head><body id="main-site-home">main</body></html>', {
                        headers: { 'Content-Type': 'text/html; charset=UTF-8' }
                    });
                }
                if (path.startsWith('/icon/')) return new Response('fixture-icon', { headers: { 'Content-Type': 'image/webp' } });
                if (path.startsWith('/css/')) return new Response('fixture-css', { headers: { 'Content-Type': 'text/css' } });
                return new Response('asset not found', { status: 404 });
            }
        },
        fetch: (async () => { throw new Error('real network is disabled in Wiki contracts'); }) as typeof globalThis.fetch
    };
    const app = createHonoApp(() => services);

    return {
        app,
        services,
        story,
        storage,
        images,
        uploads,
        staticRequests,
        setFetch(fetchImpl) { services.fetch = fetchImpl; },
        async auth(role = 'op', csrf = `csrf-${role}`) {
            const token = await tokens.sign({ id: 1, username: `${role}-fixture`, dept: role, csrfSecret: csrf }, 7200);
            return { token, csrf };
        },
        async authHeaders(role = 'op', csrf = `csrf-${role}`) {
            const auth = await this.auth(role, csrf);
            return { Cookie: `token=${auth.token}`, 'X-CSRFToken': auth.csrf };
        },
        setUpload(upload) { uploads.next = upload; }
    };
}

export function formFields(overrides: Record<string, string> = {}) {
    return {
        agency: '闪耀色彩',
        idol: '樱木真乃',
        category_name: 'enzaP卡',
        card_name: '【fixture】',
        up_name: 'fixture-up',
        video_title: 'fixture-title',
        url: 'https://www.bilibili.com/video/BV1xx411c7mD',
        ...overrides
    };
}

export function uploadedPng(marker = 'valid-png', filename = 'fixture.png') {
    return {
        filename,
        contentType: 'image/png',
        body: new TextEncoder().encode(marker)
    };
}

export async function postMultipart(
    fixture: WikiFixture,
    path: string,
    upload: ParsedUpload,
    headers: Record<string, string>
) {
    fixture.setUpload(upload);
    return fixture.app.request(path, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'multipart/form-data; boundary=wiki-fixture' },
        body: '--wiki-fixture--'
    });
}

export async function postForm(
    fixture: WikiFixture,
    path: string,
    fields: Record<string, string>,
    headers: Record<string, string>
) {
    return fixture.app.request(path, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString()
    });
}
