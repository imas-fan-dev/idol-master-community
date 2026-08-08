# @imsweb/api

IMSWeb 后端已迁移为 TypeScript + Hono。当前唯一运行入口是 Hono Node，活动运行时统一使用
PostgreSQL 与 RustFS/S3，并提供 Sharp 和流式 multipart，监听 `127.0.0.1:3000`。
filesystem 对象存储适配器只用于显式的本地开发环境。

原 Express 与 Flask 路由均由 Hono 实现；Flask、Jinja、Gunicorn 和 uWSGI 不属于公开仓库
或活动部署。生产数据仍必须按停写、在线备份、
完整对账和单一权威写入源的闸门切换。PostgreSQL 18.4 schema 只通过版本化 migration
演进，生产切换仍需影子读、停写增量和回滚演练。

## 基础设施边界

业务代码只依赖 `src/ports/` 中的能力接口和注入的 `RuntimeServices`，不选择数据库、对象
存储、缓存、图片库或上传解析器。`src/runtime` 是唯一组合根，负责创建具体基础设施适配器
并注入 `RuntimeServices`；`src/infra` 不再定义业务接口：

```text
domains/middleware/utils -> ports contracts <- concrete infra adapters
                                  ^
                         RuntimeServices
                                  ^
                       runtime composition root

infra/db/        postgresql、repositories、sql
infra/cache/     filesystem、memory
infra/oss/       filesystem、s3（对象持久化与补偿）
infra/media/     sharp（图片校验与转换）
infra/http/      busboy、filesystem（上传和静态响应）
infra/security/  bcrypt、bcryptjs、hmac
```

业务域不得导入任何 `infra` 路径、平台绑定类型或 ORM client。Repository 按认证、审计、
新闻、活动、名片、反应、站点包和剧情能力拆分；`RuntimeServices` 不再暴露跨领域的 `core`
大接口。图片处理属于 `media` 能力，不与 `ObjectStorage` 绑定；业务只使用
`ImageProcessor` 接口，`runtime` 注入 Sharp 实例。每个中间件目录按
业务职责拆文件；替换实现时只调整 `runtime` 的实例组合和对应实现，不修改业务域或服务契约。
数据库目录按隔离边界拆分：`postgresql/` 持有连接与 Schema Strategy，`repositories/`
持有复用的 SQL Repository 实现，`sql/` 只保留 Driver 契约与查询工具。S3 目录按职责拆为 `object-storage.ts`、`upload-state-machine.ts` 和
`compensation-service.ts`：对象字节进入 S3，不可变版本映射、延迟发布、恢复与补偿状态进入注入的
统一 SQL 数据库。SQL Driver 契约是 `infra/db/sql/database.ts` 的实现层内部抽象，不向业务暴露。

项目不保留 `src/shared`。Hono 请求上下文和静态路径策略属于 `src/middleware`，前端路由
决策属于 `src/routing`；纯函数按 `src/utils/{crypto,http,media,storage,validation}` 分类。
`utils` 不提供 `index.ts`、`utils.ts` 或 `helpers.ts`；SQL Driver 契约与查询工具属于
`infra/db/sql`，共享仓储实现属于 `infra/db/repositories`，
具体中间件实现不得进入 `utils`。

## 本地验证

JavaScript 工具链要求 Node.js `>=22.13.0`，包管理器固定为 pnpm `11.10.0`。

以下命令从仓库根目录执行：

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm run check
pnpm run test
```

`pnpm run check` 会验证 Node 类型、Hono 架构边界和 Web 客户端 manifest。
`pnpm run test` 还会运行 Node、Wiki DOM/CRUD、资源和仓库级部署契约；Hono
不需要 Python Web 依赖。

## 启动

日常开发从仓库根目录运行：

```sh
pnpm dev
```

该入口会启动并等待 PostgreSQL/RustFS、幂等迁移 schema，再同时启动 API 与 Web 热更新进程；
它会禁用 `apps/api/.env` 并注入完整的隔离本地配置。API 默认监听
`http://127.0.0.1:3000`。需要只调试 API 时，可按 [`.env.example`](.env.example)
配置 `apps/api/.env`，手动启动依赖和 migration 后运行 `pnpm run dev:node`；API 会自动读取并
监听该文件，已有 shell 环境变量优先。

构建后运行：

```sh
pnpm run build
pnpm run start
```

生产环境必须在 `apps/api/.env` 或进程管理器中设置高强度
`IMS_BACKOFFICE_JWT_SECRET`。管理员登录使用 15 分钟 access JWT 与可轮换、可撤销的 30 天
refresh token；旧 `IMS_JWT_SECRET` 只用于 Backoffice 滚动兼容和代码回滚。发布前必须应用
最新 PostgreSQL 迁移。数据库导入、媒体迁移和部署配置分别见下方专项文档。

## 静态资源

Node 发布集合由 `@imsweb/web` 的生产构建生成，并通过
`apps/api/dist/client-manifest.json` 逐文件校验。`dist/client` 与 `dist/node-client` 必须包含
相同内容；数据库、上传、迁移输入或私有历史资产不会进入发布产物。

## 部署入口

`deploy/compose.yaml` 可以构建并启动 Hono API、本地 PostgreSQL 和 RustFS，但不提供反向代理
或 TLS。API 镜像包含 Web 发布物，Compose 启动时会先幂等应用 PostgreSQL migrations。由外部
受信 Nginx 接入时，将 `IMS_CLIENT_ADDRESS_SOURCE=nginx` 注入 Hono，并确保入口覆盖客户端
提供的转发头。直接访问 Hono 时保留默认 `direct`，不要信任代理头。

生产切换前仍需在目标平台核对 TLS、监听端口、防火墙、上传限制、真实数据路径和回滚责任人。

## 文档

- [数据库配置](../../docs/database-configuration.md)
- [Node 文件对象存储](../../docs/object-storage.md)
- [部署、备份与回滚](../../docs/operations-runbook.md)
- [本地依赖服务](../../deploy/README.md)
- [Hono 操作脚本](scripts/README.md)

迁移的底线不变：先验证再切流，数据库与媒体成对迁移，任何时刻只保留一个权威写入点。
