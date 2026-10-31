# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Ignidash — single-container self-hosted image.
#
# One container runs two supervised processes under tini:
#   * the Convex self-hosted backend  (/convex/run_backend.sh)
#   * the Next.js standalone server   (node server.js)
#
# The runner stage is based on the Convex backend image on purpose: that binary
# is dynamically linked against glibc 2.39 (ubuntu:noble) and cannot run on
# alpine/musl or on bookworm (glibc 2.36). Node is copied in from a Debian
# image, and the build stages use the same libc so native modules such as sharp
# are built for the runtime they will actually execute on.
#
# See PLAN-single-container-offline.md for the reasoning behind each choice.
# ---------------------------------------------------------------------------

# Digest-pinned on purpose: the backend applies in-place migrations at startup,
# so rolling it back is unsafe. Bump deliberately, then `npx convex export`.
ARG CONVEX_IMAGE=ghcr.io/convex/convex-backend@sha256:207cf95def42f01614b6e3af0af5c20d0dcaa5ff2adf258ee7bc9555576644fa
# Digest-pinned too. The `24-bookworm-slim` tag floats, so a rebuild could
# silently move the major Node version CI and the app binary run on.
# .nvmrc is 24 and package.json engines requires ^24.15.0 (jsdom 30's floor).
# Digest resolved 2026-10-31 for node:24-bookworm-slim (Node 24.22.2).
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c

# Node toolchain: shared by the two build stages and copied into the runner.
FROM ${NODE_IMAGE} AS nodejs

# Stage 1: dependencies
FROM nodejs AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Stage 2: builder
FROM nodejs AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEXT_PUBLIC_* values are inlined by Next at build time. The entrypoint patches
# the bundles at start so one image works on any host; these are only defaults.
ARG SELF_HOSTED=true
ARG NEXT_PUBLIC_CONVEX_URL=http://localhost:3210
ARG NEXT_PUBLIC_CONVEX_SITE_URL=http://localhost:3211
ARG NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED=false

ENV SELF_HOSTED=${SELF_HOSTED} \
    NEXT_PUBLIC_CONVEX_URL=${NEXT_PUBLIC_CONVEX_URL} \
    NEXT_PUBLIC_CONVEX_SITE_URL=${NEXT_PUBLIC_CONVEX_SITE_URL} \
    NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED=${NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED} \
    NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# Stage 3: runner — Convex backend + Next.js under tini
FROM ${CONVEX_IMAGE} AS runner

# tini is PID 1 so both children are reaped and signals are forwarded. The
# backend image already ships curl and ca-certificates for the readiness probe.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

# Node 24 for the app. The backend image carries its own Node for "use node"
# actions; this one is for `node server.js`.
COPY --from=nodejs /usr/local /usr/local

WORKDIR /app

RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs --home-dir /app --shell /usr/sbin/nologin nextjs \
    && mkdir -p /app/.next \
    && chown nextjs:nodejs /app/.next

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# 3000 app · 3210 Convex API/WebSocket (the browser dials this directly) · 3211 HTTP actions
EXPOSE 3000 3210 3211

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
