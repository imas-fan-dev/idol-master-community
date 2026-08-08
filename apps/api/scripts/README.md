# API 操作脚本

日常命令从 monorepo 根目录执行，或显式使用
`pnpm --filter @imsweb/api run <command>`。活动运行时只有 Hono Node、PostgreSQL 和
S3-compatible 对象存储。

| 分类 | 路径 | 数据影响 | 稳定入口 |
| --- | --- | --- | --- |
| 构建 | `build/` | 构建服务端并打包已验证的 Web 静态资源 | `pnpm run build` |
| 检查 | `checks/` | 只读架构边界 | `pnpm run check` |
| 开发快照 | `development/container-data.js` | 导出或恢复本地 PostgreSQL 与 RustFS | `pnpm run dev:data:export` / `pnpm run dev:data:restore` |
| 测试桶同步 | `development/sync-r2-to-rustfs.js` | 默认只读盘点；`--apply` 写 RustFS | `pnpm run dev:rustfs:sync-r2` |
| PostgreSQL schema | `migration/postgres-migrations.js` | 应用版本化 migration | `pnpm run migration:postgresql` |
| Fudaba 元数据 | `migration/fudaba-command.js` | 默认导出或对账；导入命令写 PostgreSQL | `pnpm --filter @imsweb/api run migration:fudaba -- extract` / `pnpm run migration:fudaba:{import,reconcile}` |
| Fudaba 媒体 | `migration/fudaba-media-sync.js` | 默认生成计划；显式 `--apply` 写对象存储 | `pnpm run media:fudaba:sync` |
| 首页资讯媒体 | `migration/legacy-information-media.js` | 默认只读；`--apply` 写对象索引 | `pnpm run media:information:sync` |
| 本地上传媒体 | `migration/local-upload-media.js` | 默认只读；`--apply` 写对象与索引 | `pnpm run media:uploads:sync` |
| Wiki 媒体 | `migration/wiki-media-sync.js` | 从 PostgreSQL 读取目录；可显式写对象存储 | `pnpm run wiki:media:sync` |
| Wiki 元数据 | `migration/wiki-metadata-audit.ts` | 默认只读；`--apply` 关联已存在媒体 | `pnpm run wiki:metadata:audit` |
| 账号运维 | `operations/accounts/` | 写 PostgreSQL 或生成密码哈希 | `pnpm run ops:account:add` / `pnpm run ops:password:hash` |

## 开发数据快照

`pnpm run dev:data:export` 会生成 PostgreSQL 自定义格式逻辑 dump、RustFS 当前对象镜像、
manifest 和 SHA-256 sidecar。默认归档位于 Git 忽略的 `data/exports/`；它包含业务数据、
用户资料和密码哈希，只能通过私有渠道传递。

```sh
pnpm run dev:data:export
pnpm run dev:data:restore -- data/exports/team-snapshot.tar.gz
```

恢复会先验证 sidecar。目标数据库已有业务表或 bucket 已有对象时默认拒绝覆盖；仅在确认目标
是本仓库开发容器后使用 `--force`。

## PostgreSQL migration

应用启动不隐式建表。发布或首次初始化必须先执行：

```sh
DATABASE_URL='postgresql://imsweb:<password>@127.0.0.1:5432/imsweb' \
  pnpm run migration:postgresql
```

迁移器持有 PostgreSQL advisory lock，校验已应用文件的 SHA-256，并在事务中依次应用未执行的
版本。不得修改已经发布的 migration 文件。

## 媒体同步

首页资讯与本地上传同步命令默认只生成审计报告。确认来源、目标 bucket、计数与哈希后才使用
`--apply`：

```sh
pnpm run media:information:sync
pnpm run media:information:sync -- --apply
pnpm run media:uploads:sync
pnpm run media:uploads:sync -- --apply
```

默认审计报告写到被 Git 忽略的 `data/migration/upload-media-manifest.json`。相同内容再次执行
会标记为 `unchanged`，不会创建新对象版本。可用 `--source` 和 `--manifest` 覆盖本地输入与报告
路径；命令只接受 `IMS_OBJECT_STORAGE=s3`。

## Wiki 媒体

`wiki:media:sync` 通过 `DATABASE_URL` 读取活动 PostgreSQL 的 Story 数据，将来源素材写入 Git
忽略的 staging，并生成 URL、SHA-256、MIME、大小和目标对象键清单。只有 `--upload` 或
`--upload-existing` 才会初始化并写入配置的 S3。

```sh
pnpm run wiki:media:sync -- \
  --staging-dir "$PWD/data/migration/wiki-import"
pnpm run wiki:metadata:audit -- --strict
```

所有写入型同步都必须在完成后回读对象并核对 SHA-256。生产切换要求严格审计为零。

## 账号运维

`operations/` 命令属于人工确认操作。新增后台账号前必须显式设置 `DATABASE_URL`、确认已备份，
并只在受控 shell 中短暂注入 `IMS_NEW_USER_PASSWORD`。`add-user` 直接写 PostgreSQL 物理表
`backoffice_accounts`，不通过滚动部署使用的 `users` 兼容视图。真实密钥、密码、数据库、清单
和备份不得写回仓库。
