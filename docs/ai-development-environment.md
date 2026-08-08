# AI 开发环境指南

本指南供 AI 编码代理在 IMSWeb 仓库中初始化、启动和验证本地开发环境。开始前仍须读取根
目录及目标 workspace 的 `.rules`；同目录的 `AGENTS.md` 与 `CLAUDE.md` 均为兼容软链接。
本指南不授权生产部署、数据迁移或清理用户已有修改。

## 1. 确认工作区

所有默认命令从仓库根目录执行：

```sh
pwd
git status --short
node --version
pnpm --version
```

统一启动器支持 macOS 和 Linux；Windows 开发使用 WSL2。要求 Node.js `>=22.13.0`，
`.nvmrc` 固定最低版本，pnpm 要求 `>=11.10.0`。可以使用现有 Node 管理器切换版本；不要
改写系统运行时或仓库锁文件来绕过版本错误。

## 2. 安装依赖

```sh
corepack enable
pnpm install --frozen-lockfile
```

依赖只能由根 `pnpm-lock.yaml` 安装。不要在 workspace 中生成子锁文件，也不要使用
`npm install`。仓库将 pnpm 的脚本前依赖检查设为 `warn`，因此 doctor 和其他脚本不会隐式
安装或改写依赖；发现缺失后显式运行上述安装命令。安装需要下载依赖时，AI 应遵守当前网络和
权限审批规则。

根 workspace 的 `prepare` 由 Husky 托管，并把当前仓库的 `core.hooksPath` 配置为
`.husky/_`。提交前 hook 会检查 staged diff、仓库规则与边界、Web lint/typecheck，以及
API 语法、类型和架构边界。容器依赖 stage 统一设置 `HUSKY=0`，不会安装或执行 Git hook，
但仍保留业务依赖所需的 lifecycle scripts。可用以下命令重新安装并手动执行同一组检查：

```sh
pnpm run prepare
pnpm run check:pre-commit
```

## 3. 一键启动

日常开发先执行只读诊断，再从仓库根目录启动完整热更新环境：

```sh
pnpm run dev:doctor
pnpm dev
```

`pnpm dev` 会依次完成以下工作：

1. 检查平台、Node/pnpm 版本、workspace 依赖、API/Web 端口和 Compose 运行时，不会终止
   占用端口的未知进程。
2. 解析当前 Docker/Podman endpoint；只有 Unix socket、named pipe 或回环地址才允许继续。
3. 从 `deploy/compose.yaml` 启动 PostgreSQL 与 RustFS，并等待数据库和 S3 API 就绪。
4. 幂等初始化 RustFS bucket、公开读取策略与版本控制，再应用全部 PostgreSQL migrations。
5. 启动 Hono `tsx watch`，等待真实 API 请求成功后启动 React Router Web。
6. 通过 Web 开发代理再次探测 API，最后报告实际可访问地址。

默认 Web 为 `http://127.0.0.1:5173`，API 为 `http://127.0.0.1:3000`，RustFS S3 API 为
`http://127.0.0.1:9000`，控制台为 `http://127.0.0.1:9001`。需要避开已有端口时使用：

```sh
pnpm dev --api-port 3100 --web-port 5174
# 或设置 IMS_DEV_API_PORT / IMS_DEV_WEB_PORT
```

启动器会把实际 API 地址传给 Web，并把实际 Web 地址传给 API，不需要手工同步两个 origin。
本地数据库、对象存储和相互独立的 Backoffice/Platform 开发 JWT 配置由启动器注入，不需要
先创建 `apps/api/.env`。统一入口
设置空的 `IMS_ENV_FILE`，并在启动 API/Web 前移除继承的 `IMS_*`、数据库和 AWS 凭据，再只
注入本地所需值；生产 `.env` 或 shell 配置不会污染本地 API。细粒度 API 入口仍按原契约读取
`apps/api/.env`。

统一启动器默认把 Fudaba 公开读取、写入和区域地图三个开关保持为 `false`。需要本地验证只读
区域地图时，使用专用开发变量显式启用，并指向仓库内置的同源样式：

```sh
IMS_DEV_FUDABA_PUBLIC_READ_ENABLED=true \
IMS_DEV_FUDABA_MAP_ENABLED=true \
IMS_DEV_FUDABA_MAP_STYLE_URL=/maps/exchange-style.json \
pnpm dev
```

只有测试已认证写操作时才另外设置 `IMS_DEV_FUDABA_WRITE_ENABLED=true`。启动器会严格校验这四个
`IMS_DEV_*` 值，再转译为 API 的 `IMS_FUDABA_*` 配置；直接继承的生产开关仍会被清除。内置
`exchange-style.json` 与 `/maps/china-provinces.json` 都由当前 Web origin 提供，不声明外部
tile、glyph 或 sprite，因此地图底图不会发起第三方请求。

需要在 API/Web 热更新期间使用 Cloudflare R2 测试桶时，使用显式入口：

```sh
pnpm run dev:r2
# 同样支持：pnpm run dev:r2 --api-port 3100 --web-port 5180
```

该模式继续启动本地 PostgreSQL 和应用 migrations，但不启动或初始化 RustFS。启动器从
`apps/api/.env` 中仅提取 `IMS_OBJECT_STORAGE`、`IMS_S3_*`、公开读取基址和 AWS 凭据；
`NODE_ENV`、JWT、数据库和本地数据目录仍由开发启动器隔离注入。为防止本地热更新
误写生产对象，bucket 名必须明确包含独立的 `test` 段，region 必须为 `auto`，endpoint 必须是
无凭据、无路径的 Cloudflare R2 HTTPS S3 API 地址。需要使用另一个被忽略的配置文件时设置
`IMS_DEV_R2_ENV_FILE`。

doctor 会显示解析到的容器 endpoint，并通过同一 Compose 项目执行只读 `ps` 探测。若
`DOCKER_HOST`、`DOCKER_CONTEXT`、`CONTAINER_HOST`、`CONTAINER_CONNECTION` 或 Podman 默认
connection 指向非回环主机，`pnpm dev` 和 `pnpm run dev:down` 都会在任何容器写操作前拒绝执行。
Docker 与 Podman 目标变量混用时也会逐项校验，避免本地地址掩盖实际的远端目标。先切回本机
context，不要通过远程 context 运行本地开发入口。

`Ctrl+C` 只停止本次创建的 API/Web 热更新进程，保留 PostgreSQL、RustFS 和数据卷；确认不再
使用后执行 `pnpm run dev:down`。该命令同样不会删除卷。

## 4. 定制本地数据

配置模板按所有者分别位于 `apps/api/.env.example`、`apps/web/.env.example` 和
`deploy/.env.example`。只有需要覆盖 Compose 的本地端口或凭据时才创建 `deploy/.env`：

```sh
cp deploy/.env.example deploy/.env
pnpm dev
```

启动器会让宿主机 API 配置自动对齐 `deploy/.env` 中的 `IMS_POSTGRES_*` 和
`IMS_RUSTFS_*`，并把同一组解析后的字面值传给 Compose；不要在该文件中嵌套 `${...}` 引用。
API 独立启动时自动读取 `apps/api/.env`，已有 shell 或进程管理器变量优先；
`migration:postgresql` 也读取同一文件。`apps/api/.env.example` 是生产和高级配置模板，不能在
未填写必需值时原样用于开发。

Platform 注册邮箱验证码在 `NODE_ENV=development` 且未设置
`IMS_PLATFORM_EMAIL_DELIVERY` 时默认使用 `console`，只把验证码写入本地 API 日志。也可显式
设置为 `disabled` 或 `console`；`disabled` 会让验证码发送不可用。生产环境禁止 `console`，
上线时必须设置 `IMS_PLATFORM_EMAIL_DELIVERY=cloudflare`，并配置
`IMS_CLOUDFLARE_EMAIL_ACCOUNT_ID`、`IMS_CLOUDFLARE_EMAIL_API_TOKEN`、
`IMS_PLATFORM_EMAIL_FROM` 和 `IMS_PLATFORM_EMAIL_FROM_NAME`。Account ID 必须是 32 位十六进制
值，API Token 属于密钥，发件地址必须来自已接入 Cloudflare Email Service 的发件域；不得把这些
值提交到 Git。生产环境未配置时会退回 `disabled`，这不满足邮箱注册上线门禁。

本地运行统一使用 PostgreSQL 与 S3 兼容的 RustFS。
需要绕过统一启动器排障时，可以分别启动依赖：

```sh
pnpm run dev:postgresql:up
pnpm run dev:rustfs:up
docker compose -f deploy/compose.yaml ps postgres rustfs rustfs-init
```

RustFS S3 API 位于 `http://127.0.0.1:9000`，管理控制台位于
`http://127.0.0.1:9001`。`pnpm run dev:rustfs:down` 默认保留 `rustfs-data` 卷；只有明确
需要清空测试对象时才可另外执行带 `--volumes` 的 Compose 清理。
`imsweb-media-local` 对公开对象开放下载，但匿名策略拒绝包含 `__protected/` 的路径；本地公开
URL 由该 bucket 的 path-style 基址继续拼接可选 `IMS_S3_PREFIX` 和业务语义物理路径。

需要把线上 R2 测试桶复制到本地 RustFS 时，将只读/对象读取凭据保存在 Git 忽略的
`deploy/.env.r2-test`。先做只读盘点，再显式同步；同步命令拒绝非测试桶，也不会删除 RustFS
中的目标独有对象：

```sh
pnpm run dev:rustfs:sync-r2
pnpm run dev:rustfs:sync-r2 -- --apply
```

写入结束后命令会重新列举源和目标，要求对象键集合与逐对象字节数完全一致。本地默认
`IMS_S3_PREFIX` 为空，因此从测试桶复制下来的物理键可直接由同构的数据库对象索引引用。

`data/` 被 Git 忽略，不得把数据库、上传或日志移动到 `public/`，也不得提交。
数据库职责、PostgreSQL 选项、生产路径和完整性检查见
[数据库配置](database-configuration.md)。

`pnpm dev` 会自动初始化新空库并应用 schema 更新。独立流程可运行
`pnpm run migration:postgresql`。该 Compose 密码仅限回环地址上的本地开发。

如果 PostgreSQL 里的活动、资讯或名片记录沿用 `/uploads/...` 地址，还必须先对账并把本地上传
同步到 RustFS；设置 `IMS_OBJECT_STORAGE=s3` 本身不会搬迁文件：

```sh
pnpm run media:uploads:sync
pnpm run media:uploads:sync -- --apply
pnpm run media:information:sync
pnpm run media:information:sync -- --apply
pnpm run wiki:media:sync -- --upload-existing
pnpm run wiki:metadata:audit
pnpm run wiki:metadata:audit -- --apply --strict
```

每组的第二条命令才会写入，且会通过当前对象状态机维护 PostgreSQL 索引并从 RustFS 回读核对。
前一组迁移 Event、News 和名片上传，后一组迁移首页活动资讯索引及其 6 张历史原图。
Wiki 媒体先按清单同步，再由元数据审计关联数据库逻辑键；活动数据报告未归零时不得切换 Wiki
读模型。`--apply` 不创建业务实体，只关联已经存在且可回读的企划图标和偶像头像。
已有 S3-compatible bucket 的旧逻辑 key 使用 `pnpm run migration:object-keys` 盘点，再以
`--apply --delete-source --confirm-bucket <bucket>` 一次性切换；运行时不提供旧路径双读。
已有受保护但应公开的 ready 媒体使用 `pnpm run migration:public-objects` 生成位置报告；只有在
停写窗口精确确认当前单一 bucket 后才执行 `--apply`。

需要打包并私下分享当前开发容器的 PostgreSQL 与 RustFS 数据时，使用 API workspace 提供的
逻辑快照命令。默认产物和 SHA-256 sidecar 位于 Git 忽略的 `data/exports/`：

```sh
pnpm run dev:data:export
pnpm run dev:data:restore -- data/exports/<snapshot>.tar.gz
```

归档包含用户资料和密码哈希，不得提交到 Git。恢复到非空开发容器必须人工确认后增加
`--force`；详细格式、覆盖语义和自定义输出路径见 `apps/api/scripts/README.md`。

## 5. 高级启动方式

需要验证构建后的 Compose Hono API 镜像，而不是进行源码热更新时执行：

```sh
pnpm run dev:api:up
curl --fail --silent --show-error \
  http://127.0.0.1:3000/api/wiki/test >/dev/null
```

该容器集成预览路径会等待 PostgreSQL 与 RustFS 就绪、创建 bucket、幂等应用 migrations，再
启动 API，但不提供源码热更新；本地变量见 `deploy/.env.example`。

需要让本地 Compose API 直接测试 Cloudflare R2 时，在被 Git 忽略的 `apps/api/.env` 中配置
`IMS_S3_*`、`AWS_ACCESS_KEY_ID` 和 `AWS_SECRET_ACCESS_KEY`，并使用独立入口：

```sh
pnpm run dev:api:r2:config
pnpm run dev:api:r2:up
curl --fail --silent --show-error \
  http://127.0.0.1:3000/api/wiki/test >/dev/null
```

该入口继续使用 Compose 内的本地 PostgreSQL、开发模式和 3000 端口，但不启用或依赖 RustFS；
R2 凭据不会写入命令、Compose 文件或 Git。R2 使用 `auto` region、S3 API endpoint 和关闭
path-style 寻址，公开读取基址应使用绑定到该 bucket 的自定义域名。优先为本地测试使用独立
bucket 或限制到目标 bucket 的凭据，避免测试写入污染其他环境。

只排查单个 workspace 时，可在配置并启动本地依赖后使用细粒度入口。API 的 `tsx watch` 会在
导入的 TypeScript 源码或 `apps/api/.env` 变化时自动重启：

```sh
pnpm run dev:node
```

另一个终端启动 Web；默认开发代理已经指向 `http://127.0.0.1:3000`：

```sh
pnpm run dev:web
```

如果独立 Hono 使用其他 `PORT`，必须在 Web 进程中同步设置 `IMS_API_ORIGIN`。统一的
`pnpm dev` 会自动完成该映射并使用 strict port，端口冲突时直接失败而不会静默跳到其他地址。

启动后至少验证：

```sh
curl --fail --silent --show-error \
  http://127.0.0.1:3000/api/news >/dev/null
```

还应使用浏览器或 Playwright 检查本次修改涉及的真实页面。若用户要求“启动环境”，AI 必须
报告实际可访问 URL 和探测结果；除非用户要求停止，否则不要在验证后悄悄终止其开发服务。

## 6. 选择验证门禁

```sh
# 仓库边界或文档
pnpm run check:rules
pnpm run check:root
pnpm run test:infra

# API
pnpm run check:api
pnpm run test:api

# Web
pnpm run check:web
pnpm run test:web

# 跨 workspace 变更
pnpm run check
pnpm run test

```

先运行与修改范围匹配的最小门禁，再按影响面扩大。测试需要监听回环端口、写工具缓存或下载
浏览器时，应把环境权限问题与产品失败分开报告，不要通过修改业务代码规避沙箱限制。

## 7. AI 操作边界

- 保留开始时已经存在的 staged、unstaged 和 untracked 修改。
- 不提交密钥、数据库、上传、日志、构建产物或 `.env`。
- 不执行 PostgreSQL 生产迁移、数据切换或清理；这些操作需要独立审批和对账证据。
- 运行 `pnpm dev` 或 `pnpm run dev:down` 前保留容器 endpoint 的本机校验；不要对远程 context
  放宽或绕过该保护。
- `deploy/compose.yaml` 保存 PostgreSQL 和构建后的 Hono API；本地 `local-storage` profile
  额外启动 RustFS，生产可关闭该 profile 并直接配置 R2。Compose 不包含反向代理或 TLS 入口；
  `deploy/nginx/` 仅保存宿主机入口模板，不由开发 Compose 启动。
- Cloudflare R2 仅作为 S3-compatible 对象存储与自定义域名 CDN；本计划不部署 Worker 或 D1。
- 不使用破坏性 Git、数据库或文件清理命令，除非用户明确授权并已核对目标。
- 完成时报告修改文件、实际运行的门禁、未通过原因、运行中的服务和可访问地址。
