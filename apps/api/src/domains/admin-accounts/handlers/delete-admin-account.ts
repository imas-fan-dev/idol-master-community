import type { Context } from 'hono';
import type { AppEnvironment } from '@/app';
import { writeAudit } from '@/domains/audit/hono-service';
import {
    adminAccountRepository,
    backofficeAuthRepository
} from '@/middleware/hono-context';

export async function handleDeleteAdminAccount(c: Context<AppEnvironment>): Promise<Response> {
    const id = Number(c.req.param('id'));
    if (!Number.isSafeInteger(id) || id <= 0) {
        return c.json({ success: false, message: '管理员账号 ID 无效' }, 400);
    }
    const actor = c.get('backofficeUser')!;
    const target = await backofficeAuthRepository(c).findUserById(id);
    if (!target || target.dept !== 'op') {
        return c.json({ success: false, message: '管理员账号不存在' }, 404);
    }
    if (target.id === actor.id) {
        return c.json({ success: false, message: '不能删除当前登录账号' }, 409);
    }
    if (target.admin_role === 'super_admin') {
        return c.json({ success: false, message: '不能删除最高管理员' }, 409);
    }
    const deletion = await adminAccountRepository(c).deleteAdminAccount(id);
    if (deletion === 'moderation-history') {
        return c.json({
            success: false,
            message: '该管理员已有 Fudaba 审核记录，不能删除'
        }, 409);
    }
    if (deletion !== 'deleted') {
        return c.json({ success: false, message: '管理员账号状态已发生变化' }, 409);
    }
    await writeAudit(c, '删除管理员', target.username);
    return c.json({ success: true });
}
