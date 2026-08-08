# Node 文件对象存储

Hono Node 活动运行时统一使用 `s3` 可变媒体存储；不设置 `IMS_OBJECT_STORAGE` 时默认创建
S3 client。S3 配置缺失时服务拒绝初始化，不会回退到本地磁盘。`filesystem` 适配器只用于
显式的本地开发与测试流程。

业务代码只依赖 `ObjectStorage` 和 `CompensationService` 端口，Node 组合根负责选择
filesystem 或 S3 实例。S3 的对象字节保存在 bucket，上传状态、逻辑 key 映射和补偿任务保存在
当前 PostgreSQL 数据库；两部分都通过抽象实例注入，domain 不感知具体对象存储 provider。

S3 模式采用控制面与数据面分离：业务 URL 仍保持 `/uploads/*`、`/image/*` 等稳定路径。
Hono 完成数据库映射、对象存在性检查和受保护资源鉴权后，公开对象返回单一 bucket 的 CDN
地址，受保护对象返回短期签名 URL；浏览器随后直接从 RustFS、R2、MinIO 或其他 S3-compatible 服务获取
对象字节。上传、MIME/尺寸校验、格式转换、数据库提交和失败补偿始终由 Hono 执行。动态
`/api/thumbnail` 需要后端转换图片，是唯一保留后端读取对象正文的图片接口。

R2 只通过 S3-compatible API 和绑定到单一 bucket 的自定义域名接入。本项目不部署
Cloudflare Worker，不读取 Worker binding，也不使用 D1。

## 存储边界

S3 adapter 对业务保存与现有 `ObjectStorage` 端口相同的逻辑 key：

- `editorial/{news,events,information}/`：资讯、活动与首页活动内容；
- `editorial/about/`：关于页配置、首屏主视觉与成员头像；
- `community/namecards/`：用户投稿名片；
- `brand/{works,fonts}/`：系列介绍角色立绘与标题字体；
- `chronicle/{media,metadata,trash}/`：编年史审核流；
- `wiki/{agencies,shared}/`：Wiki 角色、剧情与公共素材；
- `site-packages/`：管理员站点包不可变版本；
- `system/migrations/`：迁移审计对象。

公开写入不会直接使用逻辑 key 作为 bucket key，而是保存为
`<IMS_S3_PREFIX>/<逻辑目录>/objects/<object-id>/<文件名>` 不可变对象。例如逻辑 key
`wiki/agencies/sc/idols/sakuragi_mano/avatar.webp` 对应物理 key
`v1/wiki/agencies/sc/idols/sakuragi_mano/objects/<object-id>/avatar.webp`。统一数据库中的
`s3_object_index` 负责逻辑 key 映射，`s3_upload_operations` 负责
`uploading -> pending/ready -> deleted` 状态迁移。待审核对象固定写入
`<IMS_S3_PREFIX>/__protected/`；ready 对象不区分业务目录，统一写入公开语义路径。发布时在同一
bucket 内复制为新的公开 ready 版本并清理受保护版本。覆盖已有对象时继续提供旧 ready 版本，
失败补偿会恢复旧映射。运行时只认
数据库记录的 canonical logical key 与 `physical_key`，不读取 direct key，也不兼容
`__ims_s3`。

作品系列页是公开品牌资产的例外读取面：前端从迁移清单引用当前 ready 版本的不可变 R2
`physical_key` URL，浏览器直接访问 R2 自定义域名，不经过 Hono。R2 bucket CORS 仅允许正式站点
与明确的本地开发 origin 执行 `GET`，以支持跨域字体；旧 `/assets/...` 路由只保留外部链接兼容。
生产 CORS 的可审计配置位于 `deploy/r2-public-cors.json`，使用最新版 Wrangler 应用并回读：

```sh
pnpm dlx wrangler@latest r2 bucket cors set imsweb-media-public-prod \
  --file deploy/r2-public-cors.json
pnpm dlx wrangler@latest r2 bucket cors list imsweb-media-public-prod
```

以下内容不进入 S3：

- Core/Story 关系数据，由一个 `DATABASE_URL` 指向的 PostgreSQL 数据库持有；
- filesystem 模式的删除补偿仍由 `IMS_COMPENSATION_DIR` 指向本地持久卷；S3 模式的补偿、
  重试租约和隔离状态保存在统一数据库的 `s3_compensation_jobs`；
- 编年史幂等 journal 仍由 `IMS_IDEMPOTENCY_DIR` 指向本地持久卷；
- 构建后的 Web 静态文件，仍由 `IMS_PUBLIC_DIR` 提供。

## 配置

| 变量 | 要求 |
| --- | --- |
| `IMS_OBJECT_STORAGE` | `filesystem` 或 `s3`，默认 `s3`；filesystem 仅用于本地开发与测试 |
| `IMS_S3_BUCKET` | S3 模式必填；普通 bucket 名称 |
| `IMS_PUBLIC_READ_URL_BASE` | 可选；filesystem 使用的公开站点前缀，或单一 bucket 的 RustFS/R2 公开基址 |
| `IMS_S3_PUBLIC_READ_URL_BASE` | `IMS_PUBLIC_READ_URL_BASE` 的 S3 兼容别名；新配置应使用通用名称 |
| `IMS_S3_REGION` | S3 模式必填；未设置时读取 `AWS_REGION` |
| `IMS_S3_PREFIX` | 可选；同一 bucket 内的隔离前缀，不含开头/结尾 `/` |
| `IMS_S3_ENDPOINT` | S3-compatible 服务可选；无凭据的 HTTP(S) URL |
| `IMS_S3_FORCE_PATH_STYLE` | 默认 `false`；RustFS、MinIO 等服务通常使用 `true` |
| `IMS_S3_READ_URL_TTL_SECONDS` | 签名读取 URL 有效期，默认 `300`，允许 `30..3600` 秒 |

`IMS_S3_PREFIX` 可以完全留空，也可以是 `tenant/site-a` 这样的多段值。最终物理路径固定为
`bucket/<IMS_S3_PREFIX>/<业务语义目录>/objects/<object-id>/<文件名>`；受保护对象在 prefix 后
额外增加 `__protected/`。留空时 bucket 后直接接业务语义目录。
`IMS_PUBLIC_READ_URL_BASE` 标识公开入口：filesystem 会在此前缀后拼接现有公开路由，
S3/R2 会拼接版本化物理对象键。RustFS path-style URL 应
包含 bucket，例如 `https://objects.example.com/imsweb-media-prod`；R2 自定义域名已绑定
bucket，因此只填写 `https://media.example.com`。两者都会继续拼接相同的 prefix 与物理路径。

`IMS_S3_ENDPOINT` 会进入私有签名 URL，因此必须是浏览器可访问且由后端也能连接的地址。生产
RustFS 应使用独立 HTTPS 域名或对象入口，不要把容器内 DNS 名或回环地址签发给远端浏览器。
RustFS 与 Hono 位于同一宿主机时，可使用 [`deploy/nginx/`](../deploy/nginx/README.md) 的双域名
模板：主域名代理完整 Web/API，独立对象域名在保留 Host 和 URI 的情况下代理 RustFS S3 API。
R2 S3 endpoint 始终需要签名；待审核名片和编年史图片只在 Hono 鉴权通过后获得短期 URL。
R2 自定义域名及本地 RustFS 匿名策略必须阻断所有包含 `/__protected/` 的路径，避免绕过 Hono。

公开访问由对象生命周期决定，而不是业务目录白名单或调用方选择。普通 ready 写入默认公开；
延迟发布写入和业务 pending 名片显式使用受保护访问，审核通过后才由 `publish()` 移到公开路径。
因此站点包、配置和迁移清单只要处于 ready 状态，也与其他 ready 对象使用相同 CDN 访问方式。

AWS SDK 使用标准凭据链。部署到 EC2、ECS 或其他 AWS compute 时优先绑定 IAM Role；本地
或第三方 S3-compatible 服务可临时注入 `AWS_ACCESS_KEY_ID`、
`AWS_SECRET_ACCESS_KEY`，使用短期凭据时再注入 `AWS_SESSION_TOKEN`。真实凭据不得写入
`apps/api/.env.example`、release 或进程启动命令历史。

应用不执行隐式 DDL。启用 S3 前必须执行 `pnpm run migration:postgresql` 并确认
`0009_s3_public_storage_scope` 已记录在 `ims_schema_migrations`；缺少该版本时服务拒绝初始化。

AWS S3 + IAM Role 示例：

```sh
export IMS_OBJECT_STORAGE=s3
export IMS_S3_BUCKET=imsweb-media-prod
export IMS_S3_REGION=ap-northeast-1
export IMS_S3_PREFIX=v1
export IMS_IDEMPOTENCY_DIR=/srv/ims/shared/idempotency
pnpm run start
```

S3-compatible 示例：

```sh
export IMS_OBJECT_STORAGE=s3
export IMS_S3_BUCKET=imsweb-media-prod
export IMS_S3_REGION=us-east-1
export IMS_S3_ENDPOINT=https://objects.example.com
export IMS_S3_FORCE_PATH_STYLE=true
export IMS_S3_PREFIX=v1
export IMS_S3_READ_URL_TTL_SECONDS=300
export AWS_ACCESS_KEY_ID='<access-key>'
export AWS_SECRET_ACCESS_KEY='<secret-key>'
pnpm run start
```

Cloudflare R2 示例：

```sh
export IMS_OBJECT_STORAGE=s3
export IMS_S3_BUCKET=imsweb-media-prod
export IMS_PUBLIC_READ_URL_BASE=https://imas-assets.texasoct.tech
export IMS_S3_REGION=auto
export IMS_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
export IMS_S3_FORCE_PATH_STYLE=false
export IMS_S3_PREFIX=
export AWS_ACCESS_KEY_ID='<r2-access-key-id>'
export AWS_SECRET_ACCESS_KEY='<r2-secret-access-key>'
pnpm run start
```

制作人地图提供一个真实 R2 的只读外部验收入口。它不会进入默认单元测试，也不会在没有生产
凭据的开发机或 CI 中隐式运行：

```sh
IMS_ENV_FILE=/path/to/online.env pnpm run test:r2:producer-map
```

该命令固定校验 Producer Map 的线上 bucket 与空 prefix，拒绝 MinIO、非 Cloudflare R2 endpoint、
非 `auto` region 和任何 `--apply` 写入参数，并从 R2 回读 43 张图片校验字节数与 SHA-256。
源站、配置或对象只要出现差异，命令就以非零状态退出。

系列介绍素材使用相同的先审计、后写入流程。默认命令会抓取六张角色立绘和标题字体，验证
PNG 解码、字体 SFNT 表目录、MIME、字节数与 SHA-256，并只生成 Git 忽略的 staging 和清单：

```sh
pnpm run media:brand-assets:sync
pnpm run media:brand-assets:sync -- \
  --apply \
  --confirm-source https://idol-master.top \
  --confirm-bucket "$IMS_S3_BUCKET"
pnpm run test:r2:brand-assets
```

写入通过 `S3ObjectStorage` 状态机维护数据库索引，并从 R2 和公开自定义域名回读核对。Hono 只为
清单中的六个旧角色路径提供稳定 307 映射；字体由 Hono 从 R2 同源代理，避免公开 R2 域名缺少
字体 CORS 响应头时被浏览器拒绝。运行时不开放任意 `/assets/` 对象键读取。

自定义域名必须直接绑定 `IMS_S3_BUCKET`，并用 Cloudflare WAF 阻断
`http.request.uri.path contains "/__protected/"`。对该域名配置缓存规则时，可以长期缓存包含
`/objects/<object-id>/` 的不可变物理 URL；Hono 的稳定业务 URL 只缓存重定向，不作为对象正文
缓存键。R2 不提供通用 S3 bucket versioning/access logging API，运维基线应使用应用自己的不可变
版本、PostgreSQL 状态索引、R2 审计能力和独立备份，不把 MinIO/AWS 的 bucket 设置命令照搬到
R2。R2 S3 凭据只授予该业务 bucket 的对象操作权限。

## 本地 RustFS 联调

RustFS 是 Compose 中的本地 S3 兼容服务；同一 Compose 也可启动 API，但不包含反向代理：

```sh
pnpm run dev:rustfs:up
docker compose -f deploy/compose.yaml ps rustfs rustfs-init
```

Compose 会在回环地址启动 RustFS，并由一次性 `rustfs-init` 服务创建一个启用版本控制的
`imsweb-media-local` bucket。匿名策略允许读取公开对象，但显式拒绝 `__protected/` 路径。
Hono Node 使用以下配置连接：

```sh
export IMS_OBJECT_STORAGE=s3
export IMS_S3_BUCKET=imsweb-media-local
export IMS_PUBLIC_READ_URL_BASE=http://127.0.0.1:9000/imsweb-media-local
export IMS_S3_REGION=us-east-1
export IMS_S3_ENDPOINT=http://127.0.0.1:9000
export IMS_S3_FORCE_PATH_STYLE=true
export IMS_S3_PREFIX=
export IMS_S3_READ_URL_TTL_SECONDS=300
export AWS_ACCESS_KEY_ID=imsweb-local
export AWS_SECRET_ACCESS_KEY=imsweb-local-password
```

默认 S3 API 为 `http://127.0.0.1:9000`，控制台为 `http://127.0.0.1:9001`。这些默认凭据
仅限本机开发，不能复用于共享或生产环境。停止服务使用 `pnpm run dev:rustfs:down`；该命令
保留命名卷，避免意外删除联调素材。

将线上 R2 测试桶同步到本地 RustFS 时，先使用默认只读模式确认源/目标对象数和字节数，再
显式写入：

```sh
pnpm run dev:rustfs:sync-r2
pnpm run dev:rustfs:sync-r2 -- --apply
```

源配置默认读取 Git 忽略的 `deploy/.env.r2-test`，并强制要求 Cloudflare R2 S3 endpoint、
`auto` region、关闭 path-style 且 bucket 名包含独立的 `test` 段。同步不删除目标独有对象；
若发现此类对象会拒绝继续。完成后重新列举两端并精确比较对象键与字节数。

### 本地上传媒体同步

数据库中的活动、推荐资讯和名片记录继续使用稳定的 `/uploads/...` URL，但设置 S3 变量不会
自动把 `IMS_UPLOADS_DIR` 里的旧文件写入 RustFS。切换后先执行只读对账，再显式导入：

```sh
pnpm run media:uploads:sync
pnpm run media:uploads:sync -- --apply
```

同步器只遍历 event、news、namecard 和 information 业务目录，生成文件数、字节数、MIME 和
SHA-256 清单。`--apply` 通过当前 `S3ObjectStorage` 状态机同时维护 bucket 对象与统一数据库的
`s3_*` 索引，写入后从目标重新读取校验；内容未变化的文件保持 `unchanged`。默认清单位于
`data/migration/upload-media-manifest.json`，该路径被 Git 忽略。

Legacy 名片需要同时迁移关系数据、表情计数和双面原图，不能只运行通用上传目录同步器。专用
迁移器从 Legacy 同源 API 建立快照，把每一面规范化为
`card-{id}-{front|back}.{ext}`，数据库保存稳定的 `/uploads/namecard/original/...` URL，
对象存储则使用 `community/namecards/assets/.../image.{ext}` 逻辑键。默认命令只下载到被 Git
忽略的 staging、校验图片解码与 Legacy MD5，并对账 PostgreSQL/S3-compatible 存储：

```sh
pnpm run media:namecards:sync -- \
  --source-base-url https://idol-master.top
```

检查 `data/migration/legacy-namecards/manifest.json` 后，备份 PostgreSQL，再显式确认来源和目标
bucket 执行写入：

```sh
pnpm run media:namecards:sync -- \
  --source-base-url https://idol-master.top \
  --apply \
  --confirm-source https://idol-master.top \
  --confirm-bucket "$IMS_S3_BUCKET"
```

应用顺序固定为先上传并回读全部对象，再在单个 PostgreSQL 事务中 upsert 名片、修正两面 URL、
同步表情计数并校正 `cards` identity sequence。manifest 不保存投稿 IP；数据库仍按 Legacy 行完整
保留该字段。命令不会删除不再被名片记录引用的旧对象，孤儿清理由单独审计决定。

旧首页“活动资讯与同人活动”的 6 条卡片不属于 Event/News 表，也不应继续由代码常量兜底。
新存储环境还需单独迁移它们的索引和原图：

```sh
pnpm run media:information:sync
pnpm run media:information:sync -- --apply
```

写入完成后，`/api/information` 只读取 `editorial/information/index.json`；页面与数据库仍保留
稳定的 `/uploads/information/original/...` URL，由 API 映射到
`editorial/information/assets/.../cover.<ext>`。索引不存在时返回空集合。

### Wiki 全量素材同步

Wiki 来源素材必须通过清单同步器导入，不能手工按展示名拼接对象键。同步器会遍历远端首页及
全部剧情页，并要求远端入口与 `DATABASE_URL` 指向的活动 PostgreSQL 中事务所/角色集合
一一对应。可在 shell 中设置 `DATABASE_URL`，或由 `apps/api/.env` 提供：

```sh
pnpm run wiki:media:sync -- \
  --staging-dir "$PWD/data/migration/wiki-import"
```

默认命令只写入被 Git 忽略的 staging，并生成 `manifest.json`。清单完整后，可在已经设置本节
MinIO/S3 环境变量的同一 shell 中校验本地文件并上传，无需重新抓取远端：

```sh
pnpm run wiki:media:sync -- \
  --staging-dir "$PWD/data/migration/wiki-import" \
  --upload-existing
```

也可在首次抓取时直接使用 `--upload`。两种上传模式都会通过当前对象状态机写入并回读
SHA-256，把最新完整清单写入
`system/migrations/wiki/idol-master-top-latest.json`。对象按 Wiki 业务结构落位：

| 来源路径 | 逻辑对象键 |
| --- | --- |
| `/image/{事务所}/{角色}/icon.<ext>` | `wiki/agencies/{agencyCode}/idols/{folderName}/avatar.<ext>` |
| `/image/{事务所}/{角色}/{用途}/{文件}` | `wiki/agencies/{agencyCode}/idols/{folderName}/story-images/{用途}/{文件}` |
| 来源 `/icon/agencies/{code}.webp` | `wiki/agencies/{code}/branding/icon.webp` |
| `/icon/...` | `wiki/shared/static/icon/...` |
| `/css/...` | `wiki/shared/static/css/...` |
| `/assets/...` | `wiki/shared/static/assets/...` |

`/image/*` 由 Story 数据库把展示名还原为稳定内部目录，再重定向到短期签名 URL。运行时只提供
数据库实体路由 `/icon/agencies/{id}.webp` 和 `/icon/wiki-groups/{id}.webp`；旧通用 `/icon/*`
与 `/css/*` 不再读取清单对象。manifest 保存每个素材的原始 URL、引用页面、目标键、
字节数、MIME 与 SHA-256，可用于之后的增量同步和位置审计。

上传完成后运行 `pnpm run wiki:metadata:audit`。数据库中的非空媒体逻辑键才表示业务关联，目录中
存在对象不能反向使其出现在公开 Wiki。必要时用 `--apply --strict` 关联已存在的语义化企划图标
和头像，并要求最终报告中的缺失对象、未知分类和成员关系问题全部为零。

应用需要 bucket 的 `ListBucket` 权限，以及目标 `IMS_S3_PREFIX` 下对象的
`GetObject`、`PutObject`、`DeleteObject` 权限。copy/move 由读取、版本化写入和受保护删除组合完成。
正式 bucket 名称与前缀由部署环境显式确定。MinIO/AWS 可启用其 provider 支持的版本控制、
服务端加密、访问日志和生命周期策略；R2 使用应用不可变版本、审计与备份策略。任何生命周期
策略都不能提前清理仍被 PostgreSQL 活动索引引用的对象。

## 管理员站点包

HTML/CSS/图片 ZIP 上传后以不可变版本保存：

```text
site-packages/{packageId}/revisions/{revisionId}/source.zip
site-packages/{packageId}/revisions/{revisionId}/manifest.json
site-packages/{packageId}/revisions/{revisionId}/files/{archivePath}
```

`source.zip` 和内部 manifest 只用于审计与恢复，不直接公开。公开和预览请求先从 PostgreSQL
读取版本记录，再按 `manifest_json` 的精确 `archivePath -> objectKey` 映射读取对象；映射目标
还必须等于该版本 `files/` 下的预期键，因此不能借伪造 manifest 访问 ZIP 或其他版本。站点包
入口 HTML、CSS、JavaScript、SVG、XML 和文本响应继续由 Hono `storage.get()` 代理，避免其
相对路径落到对象存储物理键。已发布版本的图片和字体先完成相同的版本、manifest 与对象键
校验，再由 Hono 返回 `307` 到 `IMS_PUBLIC_READ_URL_BASE` 下的公开直连地址；未配置公开基址时
使用短期签名读取地址。filesystem 开发模式没有对象直连能力时仍回退为 Hono 响应。

源 ZIP 的 SHA-256 同时进入版本元数据和对象写入校验。预览 URL 中的随机 bearer token 只在
创建版本或管理员主动旋转时返回一次，数据库只保存 SHA-256；旧 token 在旋转后立即失效。

公开内容 URL 只接受 `site_packages.published_revision_id` 当前指向的版本。入口 HTML 使用
`public, max-age=0, must-revalidate`，避免发布切换后缓存继续提供旧页面；版本化静态资源使用
长期 immutable 缓存。入口文档的 CSP 只额外允许实际对象直连地址的精确 origin 用于图片、
字体和媒体，不会放宽脚本、样式或网络连接来源。运行时会删除入口 HTML 中阻塞渲染的
`fonts.css` import，并从独立 CSS
响应中移除 CSP 必然拒绝的远程字体声明。历史版本的直接 URL 返回 404，但仍可通过该版本的
预览 bearer 查看；预览使用 `private, no-store`。浏览器公开入口
固定为主站的 `/sites/:slug`，该路由返回无脚本页面外壳；页面包本体也从主站
`/site-content/...` 路径加载。iframe 的 `sandbox` 不包含 `allow-same-origin`，因此即使请求
使用主站域名，页面包文档仍获得 opaque origin，脚本不能访问父页面、主站 Cookie 或存储。
CSP 继续禁止网络连接、表单、frame、object 和顶层导航，且只允许主站作为
`frame-ancestors`。

## 切换与校验

设置 S3 变量不会自动搬迁现有文件。切换权威写入源前必须停写，并把旧目录一次性迁到
canonical logical key：

| 本地来源 | S3 目标前缀 |
| --- | --- |
| `IMS_UPLOADS_DIR/{news,event,information}/` | `editorial/...` |
| `IMS_UPLOADS_DIR/namecard/` | `community/namecards/...` |
| `IMS_EVENT_BASE_DIR/{upload,used,meta,.trash}/` | `chronicle/{media,metadata,trash}/...` |
| `IMS_STORY_DATA_DIR/` | `wiki/agencies/...` |

`IMS_UPLOADS_DIR` 使用 `pnpm run media:uploads:sync -- --apply` 完成上述清单、上传和回读核对；
旧 S3/MinIO 环境使用以下命令完成只读盘点和破坏性切换：

```sh
pnpm run migration:object-keys
pnpm run migration:object-keys -- \
  --apply --delete-source --confirm-bucket "$IMS_S3_BUCKET"
```

第二条命令逐对象写入 canonical key、回读 SHA-256 后删除旧 key；不提供双读窗口。其他来源仍需
先生成文件数、总字节数和 SHA-256 manifest，再上传并从目标重新读取核对。不要把
`IMS_EVENT_BASE_DIR/.idempotency` 或 `.staging` 上传到对象存储。完成只读冒烟后，才能把
`IMS_OBJECT_STORAGE` 切为 `s3` 并恢复写入；回滚时同样只能保留一个权威写入端。

AWS CLI 可用 `head-bucket`、`list-objects-v2` 和只读下载作为上线前连通性检查。应用本身会在
首次媒体操作时使用相同凭据链，不在启动时创建 bucket 或修改 bucket 策略。

### 旧双桶到单桶的收敛

已有 R2 双桶部署切换到单桶前，必须先在自定义域名上启用 WAF：拒绝所有包含
`/__protected/` 的路径。应用仍通过 R2 S3 endpoint 和签名 URL 读取这些对象，公开对象则继续
使用 CDN 自定义域名。WAF 生效前禁止把受保护对象复制到公开桶。

将 `IMS_S3_BUCKET` 指向保留的单一 bucket、删除旧的 `IMS_S3_PUBLIC_BUCKET`，保持
`IMS_S3_PREFIX` 为空。先只读盘点旧 private bucket 与 PostgreSQL 权威清单：

```sh
pnpm run migration:single-bucket -- \
  --legacy-private-bucket imsweb-media-private-prod
```

确认输出数量后进入停写窗口，并精确确认源、目标 bucket：

```sh
pnpm run migration:single-bucket -- \
  --apply \
  --legacy-private-bucket imsweb-media-private-prod \
  --confirm-source-bucket imsweb-media-private-prod \
  --confirm-target-bucket "$IMS_S3_BUCKET"
```

命令要求源 bucket 对象与数据库清单完全一致。ready 对象保留业务语义路径；storage pending
对象和 `cards.status='pending'` 的名片写入 `__protected/` 后再拼接业务语义路径。复制结果经
HEAD 大小和 ETag 校验后，命令在同一个 PostgreSQL 事务中更新版本及上传操作索引，最后删除旧
bucket 中的源对象。目标已匹配的对象会跳过，因此失败后可重跑；旧 bucket 为空并完成访问冒烟
后才能删除。

对于单桶内仍需按公开策略纠正位置的 ready 对象，可先生成报告，再在停写窗口应用：

```sh
pnpm run migration:public-objects
pnpm run migration:public-objects -- \
  --apply \
  --confirm-bucket "$IMS_S3_BUCKET"
```

报告写入被 Git 忽略的 `data/migration/public-object-placement*.json`。新上传的 pending 名片直接
写入 `__protected/`；审核通过时 `publish()` 在同一 bucket 内移动到公开业务语义路径。
