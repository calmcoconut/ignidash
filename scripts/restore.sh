#!/usr/bin/env bash
#
# Ignidash restore: import a Convex export (scripts/backup.sh output) into a
# deployment.
#
#   scripts/restore.sh backups/ignidash-20261030T030000Z.zip.age \
#     --url http://127.0.0.1:3212 --admin-key "$SCRATCH_KEY" \
#     --confirm http://127.0.0.1:3212 --yes
#
# THIS IS DESTRUCTIVE. It replaces the contents of every table in the archive,
# so it refuses to run unless --confirm carries the exact target deployment URL.
# Point it at a scratch deployment for a restore drill; target the live one only
# when you are recovering from a bad upgrade.
#
# Encrypted archives are decrypted with age using --identity (or
# $AGE_IDENTITY_FILE). Without the key the restore fails, as it should.

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)
INVOCATION_DIR=$PWD

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { printf '%s\n' "$*"; }
ok() { printf '%b%s%b\n' "$GREEN" "$*" "$NC"; }
warn() { printf '%bwarning:%b %s\n' "$YELLOW" "$NC" "$*" >&2; }
die() {
  printf '%berror:%b %s\n' "$RED" "$NC" "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: scripts/restore.sh ARCHIVE [OPTIONS]

Imports a Convex export into a deployment, replacing existing data.

Arguments:
  ARCHIVE                A snapshot ZIP from scripts/backup.sh, or its .age
                         encrypted form

Options:
  --env-file FILE        Deployment credentials file (default: <repo>/.env.local)
  --url URL              Target deployment URL (overrides the env file)
  --admin-key KEY        Target deployment admin key (overrides the env file)
  -i, --identity FILE    age identity that decrypts ARCHIVE (default: $AGE_IDENTITY_FILE)
  --confirm TARGET       Required. Must be exactly the target deployment URL —
                         this is the guard against restoring into the wrong place
  --yes                  Skip the interactive "type RESTORE" prompt (for scripts)
  --allow-non-loopback   Permit a restore into a URL that is not loopback
  --replace-all          Also delete tables that the archive does not contain
  --table NAME           Table to check after the import (default: plans when
                         the archive has it, else the first table in the archive)
  --skip-verify          Do not query the deployment after the import
  -h, --help             Show this help

AGE_IDENTITY_FILE may also live in the env file (relative paths there resolve
against the env file's directory).

The identity that backups were encrypted to should be unencrypted: a
passphrase-protected one makes age prompt on the TTY, which works here by hand but
never from scripts/backup.sh's no-TTY cron run.

Requires node, the Convex CLI in node_modules, unzip (the archive is inspected
before a destructive import) and age for .age archives.

Exit status is non-zero when the archive cannot be read, decrypted or inspected,
when the confirmation guard fails, when the import fails, or when the post-import
check finds fewer documents than the archive contains.
EOF
}

resolve_path() {
  case "$1" in
    /*) printf '%s' "$1" ;;
    *) printf '%s/%s' "$INVOCATION_DIR" "$1" ;;
  esac
}

# Read KEY=value from an env file without sourcing it.
read_env_value() {
  local file="$1" key="$2" line="" value=""
  [ -f "$file" ] || return 0
  line=$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$file" 2>/dev/null | tail -n 1 || true)
  [ -n "$line" ] || return 0
  value=${line#*=}
  value=${value%$'\r'}
  case "$value" in
    \"*\") value=${value#\"} && value=${value%\"} ;;
    \'*\') value=${value#\'} && value=${value%\'} ;;
  esac
  printf '%s' "$value"
}

ARCHIVE=""
ENV_FILE=""
OPT_URL=""
OPT_ADMIN_KEY=""
IDENTITY_FILE="${AGE_IDENTITY_FILE:-}"
CONFIRM=""
ASSUME_YES=0
ALLOW_NON_LOOPBACK=0
REPLACE_MODE="--replace"
VERIFY=1
VERIFY_TABLE=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --env-file)
      [ "$#" -ge 2 ] || die "--env-file needs a value"
      ENV_FILE=$(resolve_path "$2")
      shift 2
      ;;
    --url)
      [ "$#" -ge 2 ] || die "--url needs a value"
      OPT_URL="$2"
      shift 2
      ;;
    --admin-key)
      [ "$#" -ge 2 ] || die "--admin-key needs a value"
      OPT_ADMIN_KEY="$2"
      shift 2
      ;;
    -i | --identity)
      [ "$#" -ge 2 ] || die "--identity needs a value"
      IDENTITY_FILE=$(resolve_path "$2")
      shift 2
      ;;
    --confirm)
      [ "$#" -ge 2 ] || die "--confirm needs a value"
      CONFIRM="$2"
      shift 2
      ;;
    --table)
      [ "$#" -ge 2 ] || die "--table needs a value"
      VERIFY_TABLE="$2"
      shift 2
      ;;
    --yes)
      ASSUME_YES=1
      shift
      ;;
    --allow-non-loopback)
      ALLOW_NON_LOOPBACK=1
      shift
      ;;
    --replace-all)
      REPLACE_MODE="--replace-all"
      shift
      ;;
    --skip-verify)
      VERIFY=0
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      die "unknown option: $1 (try --help)"
      ;;
    *)
      [ -z "$ARCHIVE" ] || die "only one archive can be restored at a time (got '$ARCHIVE' and '$1')"
      ARCHIVE=$1
      shift
      ;;
  esac
done

[ -n "$ARCHIVE" ] || die "no archive given (try --help)"
ARCHIVE=$(resolve_path "$ARCHIVE")
[ -e "$ARCHIVE" ] || die "archive not found: $ARCHIVE"
[ -f "$ARCHIVE" ] || die "not a regular file: $ARCHIVE"
[ -s "$ARCHIVE" ] || die "archive is empty: $ARCHIVE"

cd -- "$REPO_ROOT" || die "cannot enter $REPO_ROOT"

if [ -z "$ENV_FILE" ] && [ -f "$REPO_ROOT/.env.local" ]; then
  ENV_FILE="$REPO_ROOT/.env.local"
fi
if [ -n "$ENV_FILE" ] && [ ! -f "$ENV_FILE" ]; then
  die "env file not found: $ENV_FILE"
fi
if [ -n "$ENV_FILE" ] && [ -z "$IDENTITY_FILE" ]; then
  IDENTITY_FILE=$(read_env_value "$ENV_FILE" AGE_IDENTITY_FILE)
  if [ -n "$IDENTITY_FILE" ]; then
    case "$IDENTITY_FILE" in
      /*) ;;
      *) IDENTITY_FILE="$(cd -- "$(dirname -- "$ENV_FILE")" && pwd)/$IDENTITY_FILE" ;;
    esac
  fi
fi

CONVEX_URL="${OPT_URL:-${CONVEX_SELF_HOSTED_URL:-}}"
CONVEX_KEY="${OPT_ADMIN_KEY:-${CONVEX_SELF_HOSTED_ADMIN_KEY:-}}"
if [ -z "$CONVEX_URL" ] && [ -n "$ENV_FILE" ]; then
  CONVEX_URL=$(read_env_value "$ENV_FILE" CONVEX_SELF_HOSTED_URL)
fi
if [ -z "$CONVEX_KEY" ] && [ -n "$ENV_FILE" ]; then
  CONVEX_KEY=$(read_env_value "$ENV_FILE" CONVEX_SELF_HOSTED_ADMIN_KEY)
fi
[ -n "$CONVEX_URL" ] || die "no target deployment: pass --url, set CONVEX_SELF_HOSTED_URL, or add it to ${ENV_FILE:-.env.local}"
[ -n "$CONVEX_KEY" ] || die "no admin key: pass --admin-key, set CONVEX_SELF_HOSTED_ADMIN_KEY, or add it to ${ENV_FILE:-.env.local}"
case "$CONVEX_URL$CONVEX_KEY" in
  *$'\n'*) die "deployment URL and admin key must be single-line values" ;;
esac

# --- confirmation guard ---------------------------------------------------

if [ "$CONFIRM" != "$CONVEX_URL" ]; then
  die "refusing to restore without an explicit confirmation.
  This replaces the data in $CONVEX_URL.
  Re-run with: --confirm '$CONVEX_URL'"
fi

case "$CONVEX_URL" in
  http://127.0.0.1[:/]* | http://localhost[:/]* | http://\[::1\][:/]*) ;;
  *)
    if [ "$ALLOW_NON_LOOPBACK" != 1 ]; then
      die "refusing a destructive import into a non-loopback deployment ($CONVEX_URL).
  A restore is for a scratch deployment or a recovery on the host itself.
  Re-run with --allow-non-loopback only if you mean it."
    fi
    ;;
esac

if [ "$ASSUME_YES" != 1 ]; then
  if [ -t 0 ]; then
    printf 'This deletes existing data in %s. Type RESTORE to continue: ' "$CONVEX_URL"
    read -r REPLY
    [ "$REPLY" = "RESTORE" ] || die "aborted: no confirmation typed"
  else
    die "refusing to import without --yes when stdin is not a TTY"
  fi
fi

CONVEX_BIN="$REPO_ROOT/node_modules/.bin/convex"
[ -x "$CONVEX_BIN" ] || die "the Convex CLI is missing at $CONVEX_BIN — run npm install on the host first"

WORK_DIR=""
cleanup() {
  if [ -n "$WORK_DIR" ] && [ -d "$WORK_DIR" ]; then
    rm -rf -- "$WORK_DIR"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

umask 077
WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/ignidash-restore.XXXXXX") || die "cannot create a temporary directory"

# --- decrypt --------------------------------------------------------------

SOURCE="$ARCHIVE"
case "$ARCHIVE" in
  *.age)
    command -v age >/dev/null 2>&1 || die "this archive is encrypted but age is not installed"
    [ -n "$IDENTITY_FILE" ] ||
      die "this archive is encrypted: pass --identity FILE (or set AGE_IDENTITY_FILE) to decrypt it"
    [ -f "$IDENTITY_FILE" ] || die "identity file not found: $IDENTITY_FILE"
    SOURCE="$WORK_DIR/archive.zip"
    log "Decrypting $(basename -- "$ARCHIVE") ..."
    age --decrypt --identity "$IDENTITY_FILE" --output "$SOURCE" "$ARCHIVE" ||
      die "could not decrypt the archive with $IDENTITY_FILE (wrong key, or a truncated file)"
    ;;
esac

[ -s "$SOURCE" ] || die "the archive to import is empty"
MAGIC=$(head -c 2 -- "$SOURCE" | od -An -tx1 | tr -d ' \n')
[ "$MAGIC" = "504b" ] || die "not a Convex snapshot ZIP (magic: $MAGIC)"

# --- what is in the archive ----------------------------------------------

# A destructive import must not run on an archive that cannot be inspected, so
# unzip is required rather than optional.
command -v unzip >/dev/null 2>&1 ||
  die "unzip is required to inspect the archive before a destructive import (install it, e.g. via NerdTools on Unraid)"
TABLES=$(unzip -Z1 "$SOURCE" 2>/dev/null | awk -F/ 'NF == 2 && $2 == "documents.jsonl" { print $1 }' | LC_ALL=C sort -u) ||
  die "could not read the archive listing: $SOURCE"
[ -n "$TABLES" ] || die "the archive contains no table data: it is not a Convex snapshot"

log "Archive contains:"
for table in $TABLES; do
  count=$(unzip -p "$SOURCE" "$table/documents.jsonl" 2>/dev/null | wc -l | tr -d ' ')
  log "  $table ($count document(s))"
done

# --- import ---------------------------------------------------------------

CLI_ENV="$WORK_DIR/convex.env"
{
  printf 'CONVEX_SELF_HOSTED_URL="%s"\n' "$CONVEX_URL"
  printf 'CONVEX_SELF_HOSTED_ADMIN_KEY="%s"\n' "$CONVEX_KEY"
} >"$CLI_ENV"

log ""
log "Importing into $CONVEX_URL ($REPLACE_MODE) ..."
if ! "$CONVEX_BIN" import "$SOURCE" --env-file "$CLI_ENV" -y "$REPLACE_MODE"; then
  die "convex import failed — the deployment may be partially restored from the archive"
fi

# --- verify ---------------------------------------------------------------

if [ "$VERIFY" != 1 ]; then
  log "Verification skipped (--skip-verify)"
  ok "Restore complete"
  exit 0
fi

verify_table="$VERIFY_TABLE"
if [ -z "$verify_table" ]; then
  if printf '%s\n' "$TABLES" | grep -qx 'plans'; then
    verify_table="plans"
  else
    verify_table=$(printf '%s\n' "$TABLES" | head -n 1)
  fi
fi

data_json=$("$CONVEX_BIN" data "$verify_table" --limit 1000000 --format jsonArray --env-file "$CLI_ENV" 2>/dev/null || true)
actual=$(printf '%s\n' "$data_json" | grep -o '"_id"' | wc -l | tr -d ' ')
[ -n "$actual" ] || actual=0

expected=$(unzip -p "$SOURCE" "$verify_table/documents.jsonl" 2>/dev/null | wc -l | tr -d ' ')
[ -n "$expected" ] || expected=0
log "Verified $verify_table: $actual document(s) in the deployment, $expected in the archive"
[ "$actual" -ge "$expected" ] ||
  die "verification failed: $verify_table has $actual document(s) but the archive has $expected"

log ""
ok "Restore complete"
log "The deployment now holds the restored data. Redeploy functions if the archive"
log "predates the current schema, then check the app before pointing users at it."
