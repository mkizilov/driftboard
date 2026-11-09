# syntax=docker/dockerfile:1.7

# driftboard in a container: one image with the sync server, which also serves the web app.
#
#   docker build -t driftboard .
#   docker run --rm -p 127.0.0.1:22160:22100 -v "$PWD/.data:/data" driftboard
#
# or, with the volume and the settings in docker-compose.yml:  docker compose up --build
#
# Stages: `base` has Node, a pinned Corepack and the pinned pnpm, `web-build` builds the web app with
# the development tools, `server-deps` installs only what the server needs to run, and `runtime` is
# Node plus those two results and the server's sources. The workspace packages are TypeScript that
# is read from source (there is no library build step), so the server runs through tsx, as
# `pnpm start:prod` does.

ARG NODE_VERSION=22.12.0
# The Corepack that Node 22.12.0 bundles (0.29.4) knows only npm's old registry signing key, so it
# stops with "Cannot find matching keyid" when it fetches any pnpm signed since the key was rotated,
# and it fetches one even though package.json pins a version. 0.31.0 and later know the new key. This
# is the newest release whose engines accept Node 22.12.0 (0.35.0 wants 22.22.2): raise both together.
ARG COREPACK_VERSION=0.34.7

# ---- base: Node, Corepack and the pinned pnpm, with the files that decide what is installed ---------
FROM node:${NODE_VERSION}-bookworm-slim AS base
ARG COREPACK_VERSION
WORKDIR /app
# Corepack goes in a prefix of its own, first on PATH, so that the Node tree and the links the image
# keeps in /usr/local/bin (yarn, yarnpkg) stay as they are. Nothing is switched off: npm checks the
# package against the integrity the registry publishes, and Corepack checks pnpm's registry signature
# and the integrity of what it downloads.
RUN npm install --global --prefix /opt/corepack "corepack@${COREPACK_VERSION}"
ENV PATH=/opt/corepack/bin:${PATH}
# pnpm as pinned by "packageManager", downloaded and verified once, here; `web-build` and `server-deps`
# inherit it, so neither fetches it again and a failure shows up in this stage.
COPY package.json ./
RUN corepack install
# Only manifests, so that the install below is redone when dependencies change and not when sources
# do. All workspace members are listed because the lockfile covers them all.
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/crdt/package.json packages/crdt/
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY bench/package.json bench/
COPY e2e/package.json e2e/
# The store is a cache, kept out of the image; node_modules cannot hard-link into it, so copy.
ENV npm_config_package_import_method=copy

# better-sqlite3 has prebuilt binaries for the usual platforms; these are for the ones it has not.
FROM base AS native
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# ---- web-build: the web app, built for production (it connects back to the origin it came from) ----
FROM native AS web-build
RUN --mount=type=cache,id=driftboard-pnpm,target=/app/.pnpm-store \
    pnpm install --frozen-lockfile --filter "@driftboard/web..."
COPY tsconfig.base.json ./
COPY packages/crdt packages/crdt
COPY packages/protocol packages/protocol
COPY apps/web apps/web
RUN pnpm --filter @driftboard/web build:prod

# ---- server-deps: the production dependencies of the server, and nothing else --------------------
FROM native AS server-deps
RUN --mount=type=cache,id=driftboard-pnpm,target=/app/.pnpm-store \
    pnpm install --frozen-lockfile --prod --filter "@driftboard/server..."

# ---- runtime ---------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
LABEL org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production \
    DRIFTBOARD_HOST=0.0.0.0 \
    DRIFTBOARD_PORT=22100 \
    DRIFTBOARD_DB=/data/driftboard.sqlite \
    DRIFTBOARD_STATIC_DIR=/app/apps/web/dist
WORKDIR /app
# node_modules of the workspace (symlinks between its members, so the layout must stay the same).
COPY --from=server-deps /app /app
COPY LICENSE ./
COPY tsconfig.base.json ./
COPY packages/crdt packages/crdt
COPY packages/protocol packages/protocol
COPY apps/server apps/server
COPY --from=web-build /app/apps/web/dist apps/web/dist
# The databases: a volume, owned by the user the server runs as.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
WORKDIR /app/apps/server
EXPOSE 22100
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.DRIFTBOARD_PORT||22100)+'/healthz').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# A signal handler is installed by the server, so it is fine as the first process; compose adds init.
CMD ["node", "--import", "tsx", "src/main.ts"]
