#!/usr/bin/env bash
#
# Ignidash backup: export the self-hosted Convex deployment to a timestamped ZIP
# and encrypt it with age.
#
#   scripts/backup.sh
#   scripts/backup.sh --output-dir /mnt/user/backups/ignidash
#
# Credentials are taken from --url/--admin-key, then from
# CONVEX_SELF_HOSTED_URL / CONVEX_SELF_HOSTED_ADMIN_KEY in the environment, then
# from the env file (--env-file, default .env.local).
#
# ENCRYPTION IS ON BY DEFAULT. Provide a recipient one of three ways:
#   AGE_RECIPIENT=age1...               a public key
#   AGE_RECIPIENTS_FILE=recipients.txt  a file of public keys (age -R)
#   AGE_IDENTITY_FILE=backup-key.txt    an identity, whose recipient is derived
# Without any of them the script refuses to write an archive, unless
# --allow-unencrypted (or IGNIDASH_BACKUP_ALLOW_UNENCRYPTED=1) is passed.
#
# Retention keeps the newest --keep-nightly (30) archives plus the newest
# archive of each of the --keep-monthly (12) most recent calendar months (UTC).
# Nothing else in the output directory is touched.
#
# The script never reads from a TTY: it is safe to run from cron.

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
Usage: scripts/backup.sh [OPTIONS]

Exports the Convex deployment to <output-dir>/ignidash-<UTC timestamp>.zip.age
(or .zip with --allow-unencrypted), then prunes old archives.

Options:
  --output-dir DIR       Where archives are written (default: $IGNIDASH_BACKUP_DIR,
                         else <repo>/backups)
  --env-file FILE        Deployment credentials file (default: <repo>/.env.local)
  --url URL              Deployment URL (overrides the env file)
  --admin-key KEY        Deployment admin key (overrides the env file)
  -r, --recipient KEY    age recipient (default: $AGE_RECIPIENT)
  -R, --recipients-file FILE
                         File of age recipients (default: $AGE_RECIPIENTS_FILE)
  -i, --identity FILE    age identity to encrypt to (default: $AGE_IDENTITY_FILE);
                         its recipient is derived with age-keygen -y
  --allow-unencrypted    Write a plaintext ZIP. Refused by default.
  --keep-nightly N       Newest N archives to keep (default: 30)
  --keep-monthly N       Newest archive of each of the N most recent months
                         to keep (default: 12)
  --no-prune             Keep every archive; skip retention
  --no-file-storage      Do not include Convex file storage in the export
  -h, --help             Show this help

Backup settings can also live in the env file: AGE_RECIPIENT,
AGE_RECIPIENTS_FILE, AGE_IDENTITY_FILE and IGNIDASH_BACKUP_DIR.

Exit status is non-zero when the export, the encryption or the pruning fails;
no partial archive is ever left behind under a normal filename.
EOF
}

resolve_path() {
  case "$1" in
    /*) printf '%s' "$1" ;;
    *) printf '%s/%s' "$INVOCATION_DIR" "$1" ;;
  esac
}

resolve_against() {
  case "$1" in
    /*) printf '%s' "$1" ;;
    *) printf '%s/%s' "$2" "$1" ;;
  esac
}

# Read KEY=value from an env file without sourcing it (a backup must not run
# arbitrary shell from .env.local). Prints nothing when the key is absent.
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

OUTPUT_DIR="${IGNIDASH_BACKUP_DIR:-}"
ENV_FILE=""
OPT_URL=""
OPT_ADMIN_KEY=""
RECIPIENT="${AGE_RECIPIENT:-}"
RECIPIENTS_FILE="${AGE_RECIPIENTS_FILE:-}"
IDENTITY_FILE="${AGE_IDENTITY_FILE:-}"
ALLOW_UNENCRYPTED="${IGNIDASH_BACKUP_ALLOW_UNENCRYPTED:-0}"
KEEP_NIGHTLY="${IGNIDASH_BACKUP_KEEP_NIGHTLY:-30}"
KEEP_MONTHLY="${IGNIDASH_BACKUP_KEEP_MONTHLY:-12}"
INCLUDE_FILE_STORAGE=1
PRUNE=1

while [ "$#" -gt 0 ]; do
  case "$1" in
    --output-dir)
      [ "$#" -ge 2 ] || die "--output-dir needs a value"
      OUTPUT_DIR=$(resolve_path "$2")
      shift 2
      ;;
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
    -r | --recipient)
      [ "$#" -ge 2 ] || die "--recipient needs a value"
      RECIPIENT="$2"
      shift 2
      ;;
    -R | --recipients-file)
      [ "$#" -ge 2 ] || die "--recipients-file needs a value"
      RECIPIENTS_FILE=$(resolve_path "$2")
      shift 2
      ;;
    -i | --identity)
      [ "$#" -ge 2 ] || die "--identity needs a value"
      IDENTITY_FILE=$(resolve_path "$2")
      shift 2
      ;;
    --allow-unencrypted)
      ALLOW_UNENCRYPTED=1
      shift
      ;;
    --keep-nightly)
      [ "$#" -ge 2 ] || die "--keep-nightly needs a value"
      KEEP_NIGHTLY="$2"
      shift 2
      ;;
    --keep-monthly)
      [ "$#" -ge 2 ] || die "--keep-monthly needs a value"
      KEEP_MONTHLY="$2"
      shift 2
      ;;
    --no-prune)
      PRUNE=0
      shift
      ;;
    --no-file-storage)
      INCLUDE_FILE_STORAGE=0
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1 (try --help)"
      ;;
  esac
done

case "$KEEP_NIGHTLY" in '' | *[!0-9]*) die "--keep-nightly must be a positive integer" ;; esac
case "$KEEP_MONTHLY" in '' | *[!0-9]*) die "--keep-monthly must be a positive integer" ;; esac
[ "$KEEP_NIGHTLY" -ge 1 ] || die "--keep-nightly must be at least 1"
[ "$KEEP_MONTHLY" -ge 1 ] || die "--keep-monthly must be at least 1"

cd -- "$REPO_ROOT" || die "cannot enter $REPO_ROOT"

if [ -z "$ENV_FILE" ] && [ -f "$REPO_ROOT/.env.local" ]; then
  ENV_FILE="$REPO_ROOT/.env.local"
fi
if [ -n "$ENV_FILE" ] && [ ! -f "$ENV_FILE" ]; then
  die "env file not found: $ENV_FILE"
fi

# Backup settings may live in the env file too, so one file configures both the
# deployment credentials and the safety net. Relative paths there resolve
# against the env file's directory (the repository root for .env.local).
if [ -n "$ENV_FILE" ]; then
  ENV_DIR=$(cd -- "$(dirname -- "$ENV_FILE")" && pwd)
  [ -n "$RECIPIENT" ] || RECIPIENT=$(read_env_value "$ENV_FILE" AGE_RECIPIENT)
  if [ -z "$RECIPIENTS_FILE" ]; then
    RECIPIENTS_FILE=$(read_env_value "$ENV_FILE" AGE_RECIPIENTS_FILE)
    [ -z "$RECIPIENTS_FILE" ] || RECIPIENTS_FILE=$(resolve_against "$RECIPIENTS_FILE" "$ENV_DIR")
  fi
  if [ -z "$IDENTITY_FILE" ]; then
    IDENTITY_FILE=$(read_env_value "$ENV_FILE" AGE_IDENTITY_FILE)
    [ -z "$IDENTITY_FILE" ] || IDENTITY_FILE=$(resolve_against "$IDENTITY_FILE" "$ENV_DIR")
  fi
  if [ -z "$OUTPUT_DIR" ]; then
    OUTPUT_DIR=$(read_env_value "$ENV_FILE" IGNIDASH_BACKUP_DIR)
    [ -z "$OUTPUT_DIR" ] || OUTPUT_DIR=$(resolve_against "$OUTPUT_DIR" "$ENV_DIR")
  fi
fi

if [ -z "$OUTPUT_DIR" ]; then
  OUTPUT_DIR="$REPO_ROOT/backups"
fi

# --- credentials ----------------------------------------------------------

CONVEX_URL="${OPT_URL:-${CONVEX_SELF_HOSTED_URL:-}}"
CONVEX_KEY="${OPT_ADMIN_KEY:-${CONVEX_SELF_HOSTED_ADMIN_KEY:-}}"
if [ -z "$CONVEX_URL" ] && [ -n "$ENV_FILE" ]; then
  CONVEX_URL=$(read_env_value "$ENV_FILE" CONVEX_SELF_HOSTED_URL)
fi
if [ -z "$CONVEX_KEY" ] && [ -n "$ENV_FILE" ]; then
  CONVEX_KEY=$(read_env_value "$ENV_FILE" CONVEX_SELF_HOSTED_ADMIN_KEY)
fi
[ -n "$CONVEX_URL" ] || die "no deployment URL: pass --url, set CONVEX_SELF_HOSTED_URL, or add it to ${ENV_FILE:-.env.local}"
[ -n "$CONVEX_KEY" ] || die "no admin key: pass --admin-key, set CONVEX_SELF_HOSTED_ADMIN_KEY, or add it to ${ENV_FILE:-.env.local}"
case "$CONVEX_URL$CONVEX_KEY" in
  *$'\n'*) die "deployment URL and admin key must be single-line values" ;;
esac

if command -v curl >/dev/null 2>&1; then
  curl -fsS --max-time 15 "$CONVEX_URL/version" >/dev/null 2>&1 ||
    die "Convex backend is not reachable at $CONVEX_URL/version — start the container first"
else
  warn "curl not found: skipping the backend reachability check"
fi

# Use the project's own CLI: no npx registry lookup, no prompts, cron safe.
CONVEX_BIN="$REPO_ROOT/node_modules/.bin/convex"
[ -x "$CONVEX_BIN" ] || die "the Convex CLI is missing at $CONVEX_BIN — run npm install on the host first"

# --- encryption -----------------------------------------------------------

ENCRYPT=0
if [ -n "$RECIPIENTS_FILE" ] || [ -n "$RECIPIENT" ] || [ -n "$IDENTITY_FILE" ]; then
  ENCRYPT=1
fi

if [ "$ENCRYPT" = 1 ]; then
  command -v age >/dev/null 2>&1 ||
    die "age is not installed but encryption is configured — install age or pass --allow-unencrypted"
  if [ -n "$RECIPIENTS_FILE" ]; then
    [ -f "$RECIPIENTS_FILE" ] || die "recipients file not found: $RECIPIENTS_FILE"
  elif [ -z "$RECIPIENT" ]; then
    command -v age-keygen >/dev/null 2>&1 || die "age-keygen is not installed, so the recipient cannot be derived from $IDENTITY_FILE"
    [ -f "$IDENTITY_FILE" ] || die "identity file not found: $IDENTITY_FILE"
    RECIPIENT=$(age-keygen -y "$IDENTITY_FILE") || die "could not read a recipient from $IDENTITY_FILE"
    [ -n "$RECIPIENT" ] || die "could not read a recipient from $IDENTITY_FILE"
  fi
elif [ "$ALLOW_UNENCRYPTED" != 1 ]; then
  die "refusing to write an unencrypted archive: set AGE_RECIPIENT, AGE_RECIPIENTS_FILE or AGE_IDENTITY_FILE, or pass --allow-unencrypted to opt out explicitly"
fi

# --- output directory and lock -------------------------------------------

mkdir -p -- "$OUTPUT_DIR" || die "cannot create output directory: $OUTPUT_DIR"
OUTPUT_DIR=$(cd -- "$OUTPUT_DIR" && pwd)

LOCK_DIR="$OUTPUT_DIR/.ignidash-backup.lock"
if ! mkdir -- "$LOCK_DIR" 2>/dev/null; then
  # A crashed run must not block cron forever; steal the lock after 12 hours.
  if [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +720 2>/dev/null || true)" ]; then
    warn "removing stale lock: $LOCK_DIR"
    rm -rf -- "$LOCK_DIR"
    mkdir -- "$LOCK_DIR" 2>/dev/null || die "another backup is still running (lock: $LOCK_DIR)"
  else
    die "another backup is still running (lock: $LOCK_DIR)"
  fi
fi

WORK_DIR=""
PARTIAL=""
cleanup() {
  if [ -n "$PARTIAL" ] && [ -f "$PARTIAL" ]; then
    rm -f -- "$PARTIAL"
  fi
  if [ -n "$WORK_DIR" ] && [ -d "$WORK_DIR" ]; then
    rm -rf -- "$WORK_DIR"
  fi
  rm -rf -- "$LOCK_DIR"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

umask 077
WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/ignidash-backup.XXXXXX") || die "cannot create a temporary directory"

# The CLI reads deployment credentials from an env file, which also keeps the
# key out of the process table and stops .env.local from retargeting the export.
CLI_ENV="$WORK_DIR/convex.env"
{
  printf 'CONVEX_SELF_HOSTED_URL="%s"\n' "$CONVEX_URL"
  printf 'CONVEX_SELF_HOSTED_ADMIN_KEY="%s"\n' "$CONVEX_KEY"
} >"$CLI_ENV"

# --- export ---------------------------------------------------------------

TS=$(date -u +%Y%m%dT%H%M%SZ)
RAW="$WORK_DIR/ignidash-$TS.zip"

log "Exporting $CONVEX_URL ..."
EXPORT_ARGS=(export --path "$RAW" --env-file "$CLI_ENV")
if [ "$INCLUDE_FILE_STORAGE" = 1 ]; then
  EXPORT_ARGS+=(--include-file-storage)
fi
if ! "$CONVEX_BIN" "${EXPORT_ARGS[@]}"; then
  die "convex export failed"
fi

[ -f "$RAW" ] || die "convex export reported success but wrote no archive"
[ -s "$RAW" ] || die "convex export produced an empty archive"
MAGIC=$(head -c 2 -- "$RAW" | od -An -tx1 | tr -d ' \n')
[ "$MAGIC" = "504b" ] || die "convex export did not produce a ZIP archive (magic: $MAGIC)"

# --- encrypt and publish --------------------------------------------------

if [ "$ENCRYPT" = 1 ]; then
  FINAL="$OUTPUT_DIR/ignidash-$TS.zip.age"
  PARTIAL="$OUTPUT_DIR/.ignidash-$TS.zip.age.partial"
  log "Encrypting with age ..."
  if [ -n "$RECIPIENTS_FILE" ]; then
    age --encrypt --recipients-file "$RECIPIENTS_FILE" --output "$PARTIAL" "$RAW" ||
      die "age encryption failed (recipients file: $RECIPIENTS_FILE)"
  else
    age --encrypt --recipient "$RECIPIENT" --output "$PARTIAL" "$RAW" ||
      die "age encryption failed (recipient: $RECIPIENT)"
  fi
else
  FINAL="$OUTPUT_DIR/ignidash-$TS.zip"
  PARTIAL="$OUTPUT_DIR/.ignidash-$TS.zip.partial"
  warn "writing an UNENCRYPTED archive because --allow-unencrypted was passed"
  cp -- "$RAW" "$PARTIAL" || die "could not copy the archive to $PARTIAL"
fi

chmod 600 -- "$PARTIAL" 2>/dev/null || true
[ -s "$PARTIAL" ] || die "the archive to publish is empty"

if [ -e "$FINAL" ]; then
  rm -f -- "$PARTIAL"
  log "Archive for $TS already exists; left it untouched: $FINAL"
else
  mv -n -- "$PARTIAL" "$FINAL" || die "could not move the archive into place: $FINAL"
  [ -e "$FINAL" ] || die "could not move the archive into place: $FINAL"
  log "Wrote $FINAL ($(wc -c <"$FINAL" | tr -d ' ') bytes)"
fi

# --- retention ------------------------------------------------------------

backup_month() {
  local base
  base=$(basename -- "$1")
  if [[ $base =~ ^ignidash-([0-9]{4})([0-9]{2})[0-9]{2}T[0-9]{6}Z\.zip(\.age)?$ ]]; then
    printf '%s-%s' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
  fi
}

prune_backups() {
  local list_file keep_file month_file
  list_file="$WORK_DIR/archives"
  keep_file="$WORK_DIR/keep"
  month_file="$WORK_DIR/months"
  : >"$keep_file"
  : >"$month_file"

  # Newest first: the timestamp in the name sorts lexicographically.
  find "$OUTPUT_DIR" -maxdepth 1 -type f \( -name 'ignidash-*.zip' -o -name 'ignidash-*.zip.age' \) -print |
    LC_ALL=C sort -r >"$list_file"

  local archive count=0
  while IFS= read -r archive; do
    if [ "$count" -lt "$KEEP_NIGHTLY" ]; then
      printf '%s\n' "$archive" >>"$keep_file"
    fi
    count=$((count + 1))
  done <"$list_file"

  local months=0 month
  while IFS= read -r archive; do
    [ "$months" -lt "$KEEP_MONTHLY" ] || break
    month=$(backup_month "$archive")
    [ -n "$month" ] || continue
    grep -qxF -- "$month" "$month_file" && continue
    printf '%s\n' "$month" >>"$month_file"
    months=$((months + 1))
    grep -qxF -- "$archive" "$keep_file" || printf '%s\n' "$archive" >>"$keep_file"
  done <"$list_file"

  local pruned=0
  while IFS= read -r archive; do
    grep -qxF -- "$archive" "$keep_file" && continue
    rm -f -- "$archive" && pruned=$((pruned + 1))
  done <"$list_file"

  # Leftovers from a killed run are not backups; clear them once they are old.
  find "$OUTPUT_DIR" -maxdepth 1 -type f -name '.ignidash-*.partial' -mmin +1440 -delete 2>/dev/null || true

  local kept
  kept=$(wc -l <"$keep_file" | tr -d ' ')
  log "Retention: kept $kept archive(s), pruned $pruned (newest $KEEP_NIGHTLY plus the newest of $KEEP_MONTHLY month(s))"
}

if [ "$PRUNE" = 1 ]; then
  prune_backups
else
  log "Retention: skipped (--no-prune)"
fi

ok "Backup complete"
