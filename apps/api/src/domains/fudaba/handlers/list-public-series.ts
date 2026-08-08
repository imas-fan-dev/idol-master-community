import type { Context } from 'hono';
import type { AppEnvironment } from '@/app';
import { assertNoFudabaQuery } from '@/domains/fudaba/public-read';
import { fudabaRepository, services } from '@/middleware/hono-context';
import { resolvePublicObjectUrl } from '@/utils/storage/public-object-url';

export async function handleListFudabaPublicSeries(
    c: Context<AppEnvironment>
): Promise<Response> {
    assertNoFudabaQuery(c.req.url);
    const rows = await fudabaRepository(c).listPublicSeries();
    const storage = services(c).storage;
    return c.json({
        items: await Promise.all(rows.map(async (row) => {
            let iconUrl: string | null = null;
            if (row.icon_object_key) {
                if (!storage) {
                    throw Object.assign(
                        new Error('公开对象读取地址未配置'),
                        { status: 503 }
                    );
                }
                iconUrl = await resolvePublicObjectUrl(
                    storage,
                    row.icon_object_key,
                    `/icon/agencies/${row.id}.webp`
                );
            }
            return {
                id: row.id,
                code: row.code,
                displayName: row.display_name,
                displayOrder: row.display_order,
                color: row.color,
                iconUrl,
                imageTransform: row.image_transform,
                activeOfficeCount: row.active_office_count
            };
        }))
    });
}
