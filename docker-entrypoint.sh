#!/usr/bin/env bash
#
# Single-container entrypoint for the merged Ignidash image.
#
# Two children under tini (PID 1):
#   1. the Convex self-hosted backend  (/convex/run_backend.sh)
#   2. the Next.js standalone server   (node server.js, uid 1001)
#
# The backend handles SIGINT only — it has no SIGTERM handler — so shutdown
# routes SIGTERM to Node and SIGINT to Convex, then reaps both. tini collects the
# backend's own children (it spawns a Node executor for "use node" actions).
set -o errexit
set -o nounset
set -o pipefail

APP_DIR=/app
BACKEND_DIR=/convex
APP_UID=1001
APP_GID=1001
BACKEND_READY_TIMEOUT_SECONDS="${BACKEND_READY_TIMEOUT_SECONDS:-90}"

# Server-side traffic stays on loopback; the browser needs a reachable origin.
INTERNAL_CONVEX_URL="${SELF_HOSTED_CONVEX_URL:-http://127.0.0.1:3210}"
INTERNAL_CONVEX_SITE_URL="${SELF_HOSTED_CONVEX_SITE_URL:-http://127.0.0.1:3211}"
PUBLIC_CONVEX_URL="${NEXT_PUBLIC_CONVEX_URL:-http://localhost:3210}"
PUBLIC_CONVEX_SITE_URL="${NEXT_PUBLIC_CONVEX_SITE_URL:-http://localhost:3211}"
APP_PORT="${PORT:-3000}"

APP_PID=""
BACKEND_PID=""
SHUTTING_DOWN=0

log() { printf '[ignidash] %s\n' "$*" >&2; }

# --------------------------------------------------------------------------
# URL patching
#
# Next inlines NEXT_PUBLIC_* at build time, so the published image ships
# localhost defaults. Rewrite the bundles at start so one image works on any
# host: server bundles point at loopback, client bundles at the public origin.
# --------------------------------------------------------------------------
patch_bundles() {
    local server_dir="${APP_DIR}/.next/server"
    local static_dir="${APP_DIR}/.next/static"

    if [[ ! -d "$server_dir" ]]; then
        log "WARN: no server bundles to patch at ${server_dir}"
        return 0
    fi

    if [[ "$INTERNAL_CONVEX_URL" != "http://localhost:3210" ]]; then
        find "$server_dir" -name '*.js' -type f -exec sed -i \
            -e "s|http://localhost:3210|${INTERNAL_CONVEX_URL}|g" \
            -e "s|http://127.0.0.1:3210|${INTERNAL_CONVEX_URL}|g" {} +
    fi

    if [[ "$INTERNAL_CONVEX_SITE_URL" != "http://localhost:3211" ]]; then
        find "$server_dir" -name '*.js' -type f -exec sed -i \
            -e "s|http://localhost:3211|${INTERNAL_CONVEX_SITE_URL}|g" \
            -e "s|http://127.0.0.1:3211|${INTERNAL_CONVEX_SITE_URL}|g" {} +
    fi

    # The client bundle is what the browser executes, so it needs the public host.
    if [[ "$PUBLIC_CONVEX_URL" != "http://localhost:3210" ]]; then
        log "patching client bundles for ${PUBLIC_CONVEX_URL}"
        find "$static_dir" -name '*.js' -type f -exec sed -i \
            -e "s|http://localhost:3210|${PUBLIC_CONVEX_URL}|g" \
            -e "s|http://127.0.0.1:3210|${PUBLIC_CONVEX_URL}|g" {} +
    fi

    if [[ "$PUBLIC_CONVEX_SITE_URL" != "http://localhost:3211" ]]; then
        find "$static_dir" -name '*.js' -type f -exec sed -i \
            -e "s|http://localhost:3211|${PUBLIC_CONVEX_SITE_URL}|g" \
            -e "s|http://127.0.0.1:3211|${PUBLIC_CONVEX_SITE_URL}|g" {} +
    fi

    if ! grep -rqF --include='*.js' "$PUBLIC_CONVEX_URL" "$static_dir" 2>/dev/null; then
        log "ERROR: client bundles do not contain ${PUBLIC_CONVEX_URL}"
        log "ERROR: the browser will not be able to reach Convex — check NEXT_PUBLIC_CONVEX_URL"
        return 1
    fi
}

# --------------------------------------------------------------------------
# Process control
# --------------------------------------------------------------------------
start_backend() {
    log "starting Convex backend (ports 3210/3211, data ${DATA_DIR:-/convex/data})"
    ( cd "$BACKEND_DIR" && exec ./run_backend.sh ) &
    BACKEND_PID=$!
}

wait_for_backend() {
    local attempt=0
    until curl -fsS --max-time 2 http://127.0.0.1:3210/version >/dev/null 2>&1; do
        attempt=$((attempt + 1))
        if ((attempt >= BACKEND_READY_TIMEOUT_SECONDS)); then
            log "ERROR: Convex backend did not answer /version within ${BACKEND_READY_TIMEOUT_SECONDS}s"
            return 1
        fi
        if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
            log "ERROR: Convex backend exited before becoming ready"
            return 1
        fi
        sleep 1
    done
    log "Convex backend is ready"
}

start_app() {
    log "starting Next.js on port ${APP_PORT}"
    ( cd "$APP_DIR" && exec setpriv --reuid="$APP_UID" --regid="$APP_GID" --init-groups -- node server.js ) &
    APP_PID=$!
}

shutdown() {
    if ((SHUTTING_DOWN)); then
        return 0
    fi
    SHUTTING_DOWN=1
    trap - TERM INT

    if [[ -n "$APP_PID" ]] && kill -0 "$APP_PID" 2>/dev/null; then
        log "stopping Next.js (SIGTERM)"
        kill -TERM "$APP_PID" 2>/dev/null || true
    fi

    if [[ -n "$BACKEND_PID" ]] && kill -0 "$BACKEND_PID" 2>/dev/null; then
        log "stopping Convex backend (SIGINT)"
        kill -INT "$BACKEND_PID" 2>/dev/null || true
    fi

    wait 2>/dev/null || true
    log "stopped"
}

trap 'shutdown; exit 0' TERM INT

# --------------------------------------------------------------------------
# Boot
# --------------------------------------------------------------------------
patch_bundles
start_backend

if ! wait_for_backend; then
    shutdown
    exit 1
fi

start_app

log "both processes are up"
set +o errexit
wait -n
EXIT_STATUS=$?
set -o errexit

log "a child process exited with status ${EXIT_STATUS}; shutting down the container"
shutdown
exit 0
