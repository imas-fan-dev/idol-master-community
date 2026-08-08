import type { ManagedSqlDatabase } from '@/infra/db/sql/database';

export const CANONICAL_FUDABA_AGENCIES = [
    {
        id: 1,
        code: '765',
        name: '765PRO',
        color: '#f34f6d',
        order: 0,
        iconObjectKey: 'wiki/shared/static/icon/765pro.webp'
    },
    {
        id: 2,
        code: '876',
        name: '876PRO',
        color: '#656a75',
        order: 1,
        iconObjectKey: 'wiki/shared/static/icon/876pro.webp'
    },
    {
        id: 3,
        code: 'cg',
        name: '灰姑娘女孩',
        color: '#2681c8',
        order: 2,
        iconObjectKey: 'wiki/shared/static/icon/cg.webp'
    },
    {
        id: 4,
        code: 'ml',
        name: '百万现场',
        color: '#ffc30b',
        order: 3,
        iconObjectKey: 'wiki/shared/static/icon/ml.webp'
    },
    {
        id: 5,
        code: 'sidem',
        name: 'SideM',
        color: '#0fbe94',
        order: 4,
        iconObjectKey: 'wiki/shared/static/icon/sidem.webp'
    },
    {
        id: 6,
        code: 'sc',
        name: '闪耀色彩',
        color: '#8dbbff',
        order: 5,
        iconObjectKey: 'wiki/shared/static/icon/sc.webp'
    },
    {
        id: 7,
        code: 'gk',
        name: '学园偶像大师',
        color: '#f39800',
        order: 6,
        iconObjectKey: 'wiki/shared/static/icon/gk.webp'
    }
] as const;

export async function seedCanonicalFudabaAgencies(
    database: ManagedSqlDatabase
): Promise<void> {
    for (const agency of CANONICAL_FUDABA_AGENCIES) {
        await database.prepare(
            `INSERT INTO agencies
                (id, code, name_cn, color, wiki_enabled, display_order,
                 banner_title, icon_object_key, icon_fit, icon_focal_x,
                 icon_focal_y, icon_zoom, icon_rotation, icon_media_revision,
                 fallback_artwork_object_key, layout_revision)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'contain', 0.5, 0.5, 1, 0, 0,
                     NULL, 0)
             ON CONFLICT(code) DO UPDATE SET
                 name_cn=excluded.name_cn,
                 color=excluded.color,
                 wiki_enabled=excluded.wiki_enabled,
                 display_order=excluded.display_order,
                 banner_title=excluded.banner_title,
                 icon_object_key=excluded.icon_object_key`
        ).bind(
            agency.id,
            agency.code,
            agency.name,
            agency.color,
            true,
            agency.order,
            `${agency.name} Banner`,
            agency.iconObjectKey
        ).run();
    }
}
