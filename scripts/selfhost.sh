#!/bin/bash
set -e

# Ignidash Self-Hosted Setup Script
# This script automates the setup process for self-hosting Ignidash with Docker.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Idempotency marker for the export gate.
#
# `deploy_convex` and `run_migrations` source .env.local into this shell, so any
# writable variable can be overwritten by that file — which is how a stray
# "_IGNIDASH_EXPORT_DONE=1" in user config used to skip the gate. The marker path
# is therefore derived inline from this shell's PID ($$ cannot be assigned by a
# config file) and never stored in a variable, so nothing in .env.local can
# influence whether the gate has already run.
trap 'rm -f -- "${TMPDIR:-/tmp}/.ignidash-export-$$"' EXIT

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "Ignidash Self-Hosted Setup"
echo "=========================="
echo ""

# Cross-platform sed -i (macOS requires '' argument, Linux does not)
portable_sed() {
    local pattern="$1"
    local file="$2"
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "$pattern" "$file"
    else
        sed -i "$pattern" "$file"
    fi
}

# Ensure .env symlink exists so Docker Compose picks up variables automatically
ensure_env_symlink() {
    ln -sf .env.local .env
}

# Check prerequisites
check_prerequisites() {
    echo "Checking prerequisites..."

    if ! command -v docker &> /dev/null; then
        echo -e "${RED}Error: Docker is not installed${NC}"
        exit 1
    fi

    if ! docker compose version &> /dev/null; then
        echo -e "${RED}Error: Docker Compose is not installed${NC}"
        exit 1
    fi

    if ! command -v node &> /dev/null; then
        echo -e "${RED}Error: Node.js is not installed${NC}"
        exit 1
    fi

    if ! command -v npx &> /dev/null; then
        echo -e "${RED}Error: npx is not available${NC}"
        exit 1
    fi

    echo "Installing dependencies..."
    npm install

    echo -e "${GREEN}All prerequisites met${NC}"
    echo ""
}

# Create .env.local from template
setup_env_file() {
    if [ -f ".env.local" ]; then
        echo -e "${YELLOW}Warning: .env.local already exists${NC}"
        read -p "Overwrite? (y/N): " overwrite
        if [ "$overwrite" != "y" ] && [ "$overwrite" != "Y" ]; then
            echo "Keeping existing .env.local"
            ensure_env_symlink
            return
        fi
    fi

    cp .env.selfhost.example .env.local

    # Prompt for access method
    echo "How will you access Ignidash?"
    echo "  1) localhost (default)"
    echo "  2) LAN IP or hostname (e.g., 192.168.1.100)"
    echo "  3) Domain with reverse proxy (e.g., mydomain.com)"
    read -p "Choice [1]: " ACCESS_CHOICE

    case "$ACCESS_CHOICE" in
        2)
            read -p "IP or hostname: " CUSTOM_HOST
            if [ -z "$CUSTOM_HOST" ]; then
                echo -e "${RED}Error: IP or hostname is required${NC}"
                exit 1
            fi
            echo "Configuring for host: $CUSTOM_HOST"
            portable_sed "s|^NEXT_PUBLIC_CONVEX_URL=.*|NEXT_PUBLIC_CONVEX_URL=http://$CUSTOM_HOST:3210|" .env.local
            portable_sed "s|^NEXT_PUBLIC_CONVEX_SITE_URL=.*|NEXT_PUBLIC_CONVEX_SITE_URL=http://$CUSTOM_HOST:3211|" .env.local
            portable_sed "s|^SITE_URL=.*|SITE_URL=http://$CUSTOM_HOST:3030|" .env.local
            ;;
        3)
            read -p "Domain (e.g., mydomain.com): " CUSTOM_DOMAIN
            if [ -z "$CUSTOM_DOMAIN" ]; then
                echo -e "${RED}Error: Domain is required${NC}"
                exit 1
            fi
            echo "Configuring for domain: $CUSTOM_DOMAIN"
            echo "  App:     https://$CUSTOM_DOMAIN"
            echo "  API:     https://api.$CUSTOM_DOMAIN"
            echo "  Actions: https://actions.$CUSTOM_DOMAIN"
            portable_sed "s|^NEXT_PUBLIC_CONVEX_URL=.*|NEXT_PUBLIC_CONVEX_URL=https://api.$CUSTOM_DOMAIN|" .env.local
            portable_sed "s|^NEXT_PUBLIC_CONVEX_SITE_URL=.*|NEXT_PUBLIC_CONVEX_SITE_URL=https://actions.$CUSTOM_DOMAIN|" .env.local
            portable_sed "s|^SITE_URL=.*|SITE_URL=https://$CUSTOM_DOMAIN|" .env.local
            ;;
        *)
            # Default: localhost, no changes needed
            ;;
    esac

    # Generate secrets
    BETTER_AUTH_SECRET=$(openssl rand -base64 32)

    # Update .env.local with generated secrets
    # Use | as delimiter since base64 can contain /
    # Wrap in quotes since base64 can contain =, /, +
    portable_sed "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=\"$BETTER_AUTH_SECRET\"|" .env.local

    ensure_env_symlink

    echo -e "${GREEN}Created .env.local with generated secrets${NC}"
    echo ""
}

# Build and start Docker containers
build_and_start_containers() {
    echo "Building and starting Docker containers..."
    docker compose up -d --build

    echo "Waiting for Convex backend to be healthy..."
    local max_attempts=30
    local attempt=0

    until docker compose exec -T ignidash curl -fsS http://127.0.0.1:3210/version > /dev/null 2>&1; do
        attempt=$((attempt + 1))
        if [ $attempt -ge $max_attempts ]; then
            echo -e "${RED}Error: Convex backend failed to start${NC}"
            echo "Check logs with: docker compose logs ignidash"
            exit 1
        fi
        sleep 2
    done

    echo -e "${GREEN}Containers started successfully${NC}"
    echo ""
}

# Generate and save Convex admin key
setup_convex_admin_key() {
    echo "Generating Convex admin key..."
    ADMIN_KEY=$(docker compose exec -T -w /convex ignidash ./generate_admin_key.sh 2>/dev/null | grep -v "^$" | tail -1)

    if [ -z "$ADMIN_KEY" ]; then
        echo -e "${RED}Error: Failed to generate admin key${NC}"
        exit 1
    fi

    # Use awk to safely replace the admin key (handles any special characters)
    awk -v key="$ADMIN_KEY" '/^CONVEX_SELF_HOSTED_ADMIN_KEY=/{$0="CONVEX_SELF_HOSTED_ADMIN_KEY=\""key"\""}1' .env.local > .env.local.tmp && mv .env.local.tmp .env.local

    echo -e "${GREEN}Convex admin key saved to .env.local${NC}"
    echo ""
}

# Sync environment variables to Convex
sync_convex_env() {
    echo "Syncing environment variables to Convex..."

    # Source the .env.local file
    set -a
    source .env.local
    set +a

    # Verify we have the required Convex credentials
    if [ -z "$CONVEX_SELF_HOSTED_URL" ] || [ -z "$CONVEX_SELF_HOSTED_ADMIN_KEY" ]; then
        echo -e "${RED}Error: CONVEX_SELF_HOSTED_URL and CONVEX_SELF_HOSTED_ADMIN_KEY must be set${NC}"
        exit 1
    fi

    # List of vars to sync to Convex (only set if they have values)
    CONVEX_VARS=(
        "SELF_HOSTED"
        "SITE_URL"
        "BETTER_AUTH_SECRET"
        "GOOGLE_CLIENT_ID"
        "GOOGLE_CLIENT_SECRET"
        "OPENAI_API_KEY"
        "OPENAI_ENDPOINT"
        "OPENAI_BASE_URL"
        "OPENAI_CHAT_MODEL"
        "OPENAI_INSIGHTS_MODEL"
    )

    local synced=0
    local skipped=0

    for var in "${CONVEX_VARS[@]}"; do
        value="${!var}"
        if [ -n "$value" ]; then
            echo "  Setting $var..."
            if npx convex env set "$var" "$value" \
                --url "$CONVEX_SELF_HOSTED_URL" \
                --admin-key "$CONVEX_SELF_HOSTED_ADMIN_KEY" \
                2>/dev/null; then
                synced=$((synced + 1))
            else
                echo -e "    ${YELLOW}Warning: Failed to set $var${NC}"
            fi
        else
            skipped=$((skipped + 1))
        fi
    done

    echo -e "${GREEN}Synced $synced environment variables ($skipped skipped - not set)${NC}"
    echo ""
}

# Read KEY=value from .env.local without sourcing it, so a config file cannot
# change this script's own state.
read_env_value() {
    local key="$1" line="" value=""
    [ -f ".env.local" ] || return 0
    line=$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" .env.local 2>/dev/null | tail -n 1 || true)
    [ -n "$line" ] || return 0
    value=${line#*=}
    value=${value%$'\r'}
    case "$value" in
        \"*\") value=${value#\"} && value=${value%\"} ;;
        \'*\') value=${value#\'} && value=${value%\'} ;;
    esac
    printf '%s' "$value"
}

# Export the deployment before anything irreversible.
#
# `convex deploy` and `migrations:runAll` are one-way: the only rollback path is
# restoring an export into the previous image. So the export is not optional —
# when it fails, this function aborts the run instead of continuing without a
# rollback point. It runs at most once per invocation, however many irreversible
# steps follow (tracked by the marker file, not by a variable).
#
# Extra arguments are forwarded to scripts/backup.sh, e.g. --expect-empty.
#
export_before_migration() {
    local marker
    marker="${TMPDIR:-/tmp}/.ignidash-export-$$"
    if [ -f "$marker" ]; then
        return 0
    fi

    echo "Exporting a backup before deploy/migrations (required)..."
    if ! bash "$SCRIPT_DIR/backup.sh" "$@"; then
        echo ""
        echo -e "${RED}Error: the pre-migration export failed — aborting${NC}"
        echo "Deploy and migrations are one-way; the export is the only rollback path."
        echo "Configure backups first (see SELF_HOSTING.md, 'Backups and restore'):"
        echo "  bash scripts/backup.sh --help"
        echo "Encrypted backups need AGE_RECIPIENT, AGE_RECIPIENTS_FILE or AGE_IDENTITY_FILE."
        echo ""
        echo "If the container is stopped, start the CURRENT image first (npm run docker:up),"
        echo "export, and only then upgrade: the backend applies migrations when it starts."
        exit 1
    fi

    : > "$marker"
    echo -e "${GREEN}Pre-migration export complete${NC}"
    echo ""
}

# Deploy Convex functions
deploy_convex() {
    echo "Deploying Convex functions..."

    # Source the .env.local file
    set -a
    source .env.local
    set +a

    export_before_migration

    npx convex deploy \
        --url "$CONVEX_SELF_HOSTED_URL" \
        --admin-key "$CONVEX_SELF_HOSTED_ADMIN_KEY"

    echo -e "${GREEN}Convex functions deployed${NC}"
    echo ""
}

# Run pending data migrations
run_migrations() {
    echo "Running pending data migrations..."

    # Source the .env.local file
    set -a
    source .env.local
    set +a

    export_before_migration

    npx convex run migrations:runAll \
        --url "$CONVEX_SELF_HOSTED_URL" \
        --admin-key "$CONVEX_SELF_HOSTED_ADMIN_KEY"

    echo -e "${GREEN}Data migrations complete${NC}"
    echo ""
}

# Print next steps
print_next_steps() {
    # Source .env.local to get the credentials
    set -a
    source .env.local
    set +a

    local APP_URL="${SITE_URL:-http://localhost:3030}"
    local CONVEX_URL="${NEXT_PUBLIC_CONVEX_URL:-http://localhost:3210}"

    echo -e "${GREEN}Setup complete!${NC}"
    echo ""
    echo "Access the application at: $APP_URL/signup"
    echo "Convex API (must be browser-reachable): $CONVEX_URL"
    echo ""
    echo "Convex deployment (for the CLI):"
    echo "  Deployment URL: $CONVEX_SELF_HOSTED_URL"
    echo "  Admin Key: $CONVEX_SELF_HOSTED_ADMIN_KEY"
    echo ""
    echo "Next steps:"
    echo "1. Edit .env.local to add optional keys (Google OAuth, OpenAI, etc.)"
    echo "2. Re-run sync to push new keys to Convex:"
    echo "   npm run selfhost -- --sync-only"
    echo "3. Schedule nightly backups on an array share (User Scripts plugin):"
    echo "   see SELF_HOSTING.md, 'Backups and restore'"
    echo ""
}

# Help text
show_help() {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  --init         First-time setup: create .env.local from template"
    echo "  --sync-only    Only sync environment variables to Convex (skip setup)"
    echo "  --deploy-only  Only deploy Convex functions (still exports a backup first)"
    echo "  --expect-empty Passed to scripts/backup.sh: accept a snapshot with no table"
    echo "                 data (a brand-new install, before its first deploy)"
    echo "  --skip-snapshot-check"
    echo "                 Passed to scripts/backup.sh: skip the export inspection, for"
    echo "                 a legitimate deployment the checks misjudge"
    echo "  --help         Show this help message"
    echo ""
    echo "Gated: this script's own paths (default, --deploy-only, and --init on an"
    echo "install that has run before) export a backup and abort if that export fails."
    echo "NOT gated, by design: 'npm run selfhost:convex-dev' (the convex dev watcher"
    echo "pushes functions per edit) and 'npm run docker:up' (the backend applies"
    echo "on-start migrations as the container boots). Export before using either on"
    echo "an install you care about."
    echo ""
}

# Check that .env.local exists
require_env_file() {
    if [ ! -f ".env.local" ]; then
        echo -e "${RED}Error: .env.local not found${NC}"
        echo "Run with --init to create a new .env.local from template"
        exit 1
    fi
    ensure_env_symlink
}

# True when a Convex backend answers at the URL in .env.local. Parsing the file
# instead of sourcing it keeps this probe side-effect free.
backend_reachable() {
    local url
    url=$(read_env_value CONVEX_SELF_HOSTED_URL)
    [ -n "$url" ] || url="http://127.0.0.1:3210"
    command -v curl > /dev/null 2>&1 || return 1
    curl -sf --max-time 10 "$url/version" > /dev/null 2>&1
}

# Main (default - requires existing .env.local)
main() {
    check_prerequisites
    require_env_file
    # The rollback point has to be taken while the CURRENT image is still
    # serving: the backend applies in-place migrations when it starts, so
    # exporting after `docker compose up` would capture a post-migration state.
    # "$@" carries the snapshot-inspection opt-ins through to scripts/backup.sh.
    export_before_migration "$@"
    build_and_start_containers
    setup_convex_admin_key
    sync_convex_env
    deploy_convex
    run_migrations
    print_next_steps
}

# Main with --init flag (creates new .env.local)
main_init() {
    check_prerequisites

    # Captured before setup_env_file can replace .env.local: an admin key means
    # this install has run before. "Backend not answering" alone is NOT proof of
    # a fresh volume — it also means "this install has data and its container is
    # stopped", which must export before anything is rebuilt or restarted.
    local previous_url previous_key
    previous_url=$(read_env_value CONVEX_SELF_HOSTED_URL)
    previous_key=$(read_env_value CONVEX_SELF_HOSTED_ADMIN_KEY)

    setup_env_file

    local existing_install=0
    if [ -n "$previous_key" ] || backend_reachable; then
        existing_install=1
    fi
    local -r existing_install_flag=$existing_install

    if [ "$existing_install_flag" = 1 ]; then
        # Export while the current image is still the one holding the data. If
        # the container is down this fails closed and tells the operator to
        # start the CURRENT image first, rather than rebuilding past the gate.
        if [ -n "$previous_key" ]; then
            CONVEX_SELF_HOSTED_URL="$previous_url"
            CONVEX_SELF_HOSTED_ADMIN_KEY="$previous_key"
            export CONVEX_SELF_HOSTED_URL CONVEX_SELF_HOSTED_ADMIN_KEY
        fi
        export_before_migration
    else
        echo "No previous deployment found: treating this as a fresh install."
        echo "The export gate runs after the container starts, before any deploy or migration."
        echo ""
    fi

    build_and_start_containers
    setup_convex_admin_key
    if [ "$existing_install_flag" = 0 ]; then
        # A brand-new volume has no schema deployed yet, so its snapshot is
        # legitimately empty. Only this path may say so.
        export_before_migration --expect-empty
    fi
    sync_convex_env
    deploy_convex
    run_migrations
    print_next_steps
}

# Handle flags
case "$1" in
    --init)
        main_init
        ;;
    --sync-only)
        require_env_file
        set -a
        source .env.local
        set +a
        if ! curl -sf http://127.0.0.1:3210 > /dev/null 2>&1; then
            echo -e "${RED}Error: Convex backend is not reachable at http://127.0.0.1:3210${NC}"
            exit 1
        fi
        sync_convex_env
        exit 0
        ;;
    --deploy-only)
        # Same deploy path as npm run selfhost, minus the container rebuild,
        # the admin-key rotation and the migrations. The export gate still
        # runs, so this entry point cannot skip the backup.
        shift
        require_env_file
        export_before_migration "$@"
        deploy_convex
        exit 0
        ;;
    --expect-empty | --skip-snapshot-check)
        # Forwarded to scripts/backup.sh for a deployment the default snapshot
        # inspection cannot judge (see bash scripts/backup.sh --help).
        GATE_ARGS="$1"
        shift
        main "$GATE_ARGS"
        ;;
    --help)
        show_help
        exit 0
        ;;
    "")
        main
        ;;
    *)
        echo -e "${RED}Unknown option: $1${NC}"
        show_help
        exit 1
        ;;
esac
