ARG NODE_VERSION=24.18.0

FROM node:${NODE_VERSION}-bookworm-slim AS pnpm-base

ARG DEBIAN_MIRROR_BASE=http://deb.debian.org
ARG NPM_REGISTRY=https://registry.npmmirror.com
ARG NODE_HEADERS_MIRROR=https://npmmirror.com/mirrors/node

ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
ENV HUSKY=0
ENV COREPACK_NPM_REGISTRY=${NPM_REGISTRY}
ENV npm_config_disturl=${NODE_HEADERS_MIRROR}

RUN sed --in-place \
        "s|http://deb.debian.org|${DEBIAN_MIRROR_BASE}|g" \
        /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install --yes --no-install-recommends g++ make python3 \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare pnpm@11.10.0 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY .husky/install.mjs .husky/install.mjs

FROM pnpm-base AS build

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm run build

FROM node:${NODE_VERSION}-bookworm-slim AS production-dependencies

ARG DEBIAN_MIRROR_BASE=http://deb.debian.org
ARG NPM_REGISTRY=https://registry.npmmirror.com

ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
ENV HUSKY=0
ENV COREPACK_NPM_REGISTRY=${NPM_REGISTRY}

RUN sed --in-place \
        "s|http://deb.debian.org|${DEBIAN_MIRROR_BASE}|g" \
        /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install --yes --no-install-recommends g++ make python3 \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare pnpm@11.10.0 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY .husky/install.mjs .husky/install.mjs

COPY --from=build /pnpm/store /pnpm/store

# The build stage already verifies this frozen lockfile before exporting its store.
RUN PNPM_CONFIG_TRUST_LOCKFILE=true \
    pnpm install --offline --frozen-lockfile --prod --filter @imsweb/api...

FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV IMS_PROJECT_ROOT=/app
ENV IMS_PUBLIC_DIR=/app/apps/api/dist/node-client
ENV IMS_ENV_FILE=

WORKDIR /app

COPY package.json ./
COPY apps/api/package.json apps/api/package.json
COPY --from=production-dependencies /app/node_modules node_modules
COPY --from=production-dependencies /app/apps/api/node_modules apps/api/node_modules
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/migrations/postgresql apps/api/migrations/postgresql
COPY --from=build /app/apps/api/scripts/migration/postgres-migrations.js \
    apps/api/scripts/migration/postgres-migrations.js

RUN mkdir -p /app/data \
    && chown node:node /app/data

USER node

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/wiki/test').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "apps/api/dist/server/main.js"]
