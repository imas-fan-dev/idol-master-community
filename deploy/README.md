# Compose 部署

`deploy/compose.yaml` 用于启动 PostgreSQL 和 IMSWeb Hono API。本地开发还会通过
`local-storage` profile 启动 RustFS；生产可以关闭该 profile，让 API 直接连接 Cloudflare R2。
API 镜像包含构建后的 Web 静态资源，并在启动前幂等应用 PostgreSQL migrations。Compose
不包含反向代理或 TLS 入口；宿主机 Nginx 的参考配置位于
[`deploy/nginx/`](nginx/README.md)，但不会作为 Compose 服务启动。

正式环境的默认发布入口是 [GitHub Actions 自动部署](../docs/github-actions-deployment.md)：CI
构建 API 镜像并推送到 GHCR，目标主机只按不可变 digest 拉取并启动。下面的 `--build` 命令用于
本地容器集成预览，不是正式服务器上的发布步骤。

从仓库根目录检查配置：

```sh
cp deploy/.env.example deploy/.env
docker compose --env-file deploy/.env -f deploy/compose.yaml config
```

日常源码开发优先运行根目录 `pnpm dev`。它会复用本 Compose 文件启动并等待 PostgreSQL/RustFS，
初始化 bucket、应用 migration，再启动宿主机上的 API/Web 热更新进程；无需先复制
`deploy/.env`。如需调整本地依赖端口或凭据，再从模板创建该文件。停止依赖且保留数据卷使用
`pnpm run dev:down`。启动和停止前可运行 `pnpm run dev:doctor`；统一入口仅允许 Unix socket、
Windows named pipe 或回环地址上的本机 Docker/Podman endpoint，远程 context 会被拒绝。

需要验证构建后容器镜像时，启动完整本地 API 栈：

```sh
pnpm run dev:api:up
docker compose -f deploy/compose.yaml ps postgres rustfs rustfs-init api
curl --fail http://127.0.0.1:3000/api/wiki/test
```

`dev:api:up` 是容器集成预览入口：它会构建 API 镜像，并按健康依赖顺序启动 PostgreSQL、
RustFS 初始化任务和 API，但不提供源码热更新。
镜像构建通过 `IMS_DEBIAN_MIRROR_BASE`、`IMS_NPM_REGISTRY` 和
`IMS_NODE_HEADERS_MIRROR` 分别覆盖 apt、Corepack/pnpm 与原生 Node headers 下载源；模板默认
使用国内 npm 镜像，并为本地构建提供国内 Debian 镜像。不要把认证信息写入这些公开 mirror URL。
只需要依赖服务或需要 Hono 源码热更新时，仍可分别运行：

```sh
pnpm run dev:postgresql:up
pnpm run dev:rustfs:up
pnpm run dev:node
```

API 仅映射到宿主机回环地址，容器内通过 `postgres:5432` 访问数据库；本地 profile 通过
`rustfs:9000` 访问对象存储，生产 R2 则使用配置的外部 S3 API endpoint。
`api-data` 卷保存 Hono 的本地运行状态，停止单个 API 容器不会删除该卷。不要把
`deploy/.env.example` 中的本地默认凭据用于共享或生产环境；共享或生产环境的数据库、对象
存储和应用秘密必须由目标平台或密钥管理服务注入。

## PostgreSQL + Cloudflare R2

生产机的 `/etc/imsweb/production.env` 应将 `COMPOSE_PROFILES` 留空，并设置完整的
`IMS_S3_*`、AWS 凭据、互不相同的高熵 `IMS_BACKOFFICE_JWT_SECRET` 与
`IMS_PLATFORM_JWT_SECRET`、`IMS_API_DATABASE_URL`，并在首次启用管理员角色时将
`IMS_SUPER_ADMIN_USERNAME` 设为现有 `op` 账号。若从旧版本滚动升级，按
[运维手册](../docs/operations-runbook.md) 暂时保留旧 `IMS_JWT_SECRET`；全新安装保持其为空。
R2 使用 `auto` region；
`IMS_S3_ENDPOINT` 是 R2 S3 API 域名，`IMS_PUBLIC_READ_URL_BASE` 是 bucket 自定义域名，
二者不能互换。手工排障时先指定 CI 已记录的不可变镜像，再渲染配置和启动 API 栈：

```sh
: "${IMS_API_IMAGE:?set the verified GHCR image@sha256 digest}"
docker compose --env-file /etc/imsweb/production.env -f deploy/compose.yaml config --quiet
docker compose --env-file /etc/imsweb/production.env -f deploy/compose.yaml pull api
docker compose --env-file /etc/imsweb/production.env -f deploy/compose.yaml \
  up -d --no-build postgres api
```

未启用 `local-storage` profile 时，Compose 不启动 RustFS；API 只使用配置的 R2 bucket。
手工排障时可以把目标主机的私有环境文件传给 Compose，但不得执行 `--build`；生产镜像必须使用
CI 记录的 GHCR digest。环境文件应保持 `0600` 权限并通过目标主机的密钥管理流程传递。
