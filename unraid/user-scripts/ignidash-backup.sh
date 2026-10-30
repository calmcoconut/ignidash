#!/bin/bash
#
# Ignidash nightly backup for the Unraid "User Scripts" plugin.
#
# Install: User Scripts -> Add New Script, paste this file, save.
# Schedule: "Daily", or a custom cron such as `0 3 * * *`.
#
# Requires from NerdTools: `age` (and `unzip`). The repository must already be cloned at
# REPO_DIR with `npm install` run once, because scripts/backup.sh drives the Convex CLI from
# node_modules.
#
# Archives go to an array share, never to the cache pool that holds the appdata. Encryption is
# on by default; retention keeps 30 nightly plus 12 monthly. See SELF_HOSTING.md,
# "Backups and restore".

set -euo pipefail

# Cron starts with a minimal PATH. NerdTools installs into /usr/bin and /usr/local/bin.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# The cloned repository (the docker compose project directory).
REPO_DIR=/mnt/user/appdata/ignidash

# Where the archives are written: an array share. Do not use /mnt/cache/...
export IGNIDASH_BACKUP_DIR=/mnt/user/backups/ignidash

# Encryption recipient. Set one of these here, or put it in REPO_DIR/.env.local
# (scripts/backup.sh reads AGE_RECIPIENT, AGE_RECIPIENTS_FILE and AGE_IDENTITY_FILE
# from either place). Until one exists the run fails closed instead of writing a
# plaintext archive.
#   export AGE_RECIPIENT=age1...
#   export AGE_IDENTITY_FILE=/root/.keys/ignidash-backup.txt

if [ ! -d "$REPO_DIR" ]; then
    echo "ignidash-backup: repository not found at $REPO_DIR" >&2
    echo "ignidash-backup: set REPO_DIR in this script to wherever you cloned Ignidash" >&2
    exit 1
fi

cd "$REPO_DIR"

# exec so the script's exit code is backup.sh's: User Scripts shows a failed run.
exec bash scripts/backup.sh
