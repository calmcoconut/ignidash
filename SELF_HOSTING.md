# Self-Hosting Ignidash

Ignidash self-hosts as **one container**. The Convex backend and the Next.js app run
as two supervised processes inside a single image (see `Dockerfile` and
`docker-entrypoint.sh`), with the backend pinned by digest.

Nothing in the stack calls a third-party service at runtime: no analytics, no
payments, no transactional email, and no OAuth provider unless you configure one.

---

## What runs where

| Port (container) | Host default | Purpose                                                |
| ---------------- | ------------ | ------------------------------------------------------ |
| 3000             | 3030         | Next.js app                                            |
| 3210             | 3210         | Convex API + WebSocket — **must be browser-reachable** |
| 3211             | 3211         | Convex HTTP actions                                    |

`/convex/data` is the only stateful path: the SQLite database, file storage, and the
instance credentials (`instance_name`, `instance_secret`). Everything else in the
container is disposable.

The browser talks to Convex directly over WebSocket, which is why 3210 is published
separately from the app. Server-side traffic never leaves the container — it uses
loopback.

---

## Requirements

- Docker with Compose v2
- Node.js 20+ **on the host** — functions are deployed with the Convex CLI from the
  host, not from inside the container
- Roughly 2 GB of RAM headroom: the backend spawns its own Node executor for
  `"use node"` actions and does not recycle it

---

## Setup

```bash
git clone https://github.com/calmcoconut/ignidash.git
cd ignidash
npm run selfhost -- --init
```

The script creates `.env.local` from the template, builds the image, starts the
container, waits for the backend, generates an admin key, syncs environment variables
into the Convex deployment, deploys functions, and runs migrations.

Before it deploys anything it exports the deployment through `scripts/backup.sh`,
and **aborts if that export fails** — deploy and migrations are one-way, so the
export is the only rollback path. `--init` writes an empty `.env.local` from
`.env.selfhost.example`, which already carries the backup keys, so the first run
stops at the export until at least one recipient source is filled in (see
[Backups and restore](#backups-and-restore)):

```dotenv
AGE_RECIPIENT=age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p
IGNIDASH_BACKUP_DIR=/mnt/user/backups/ignidash
```

Re-run `npm run selfhost` once those two lines are set. Then open
`http://<host>:3030/signup` and create your account.

### Host port overrides

`APP_PORT`, `CONVEX_PORT`, and `CONVEX_SITE_PORT` change the published host ports
without editing `docker-compose.yml`.

---

## Unraid template

`unraid/ignidash.xml` is a Community Applications-style Docker template for the single-container
image. On the Unraid box: **Docker → Add Container → Template**, paste the template URL

```text
https://raw.githubusercontent.com/calmcoconut/ignidash/main/unraid/ignidash.xml
```

then fill in the fields. It carries:

| Field                         | Default                               | Notes                                                                 |
| ----------------------------- | ------------------------------------- | --------------------------------------------------------------------- |
| Repository                    | `ghcr.io/calmcoconut/ignidash:latest` | Pin a tag or digest for upgrades you can roll back                    |
| WebUI port → 3000             | `3030`                                | The app                                                               |
| Convex API port → 3210        | `3210`                                | The browser dials this directly; it must be reachable from the client |
| Convex actions port → 3211    | `3211`                                | Auth callbacks                                                        |
| Appdata → `/convex/data`      | `/mnt/user/appdata/ignidash`          | Editable: the only stateful path (SQLite, file storage, credentials)  |
| Site URL / Convex public URLs | `http://[IP]:[PORT:…]`                | Replace the LAN IP if you edit the ports                              |
| Auth secret                   | empty, masked                         | `openssl rand -base64 32`, generated once and kept forever            |
| Allow signup                  | empty (locked)                        | Set `true` only for the bootstrap step                                |
| Google / OpenAI               | empty                                 | Optional; AI features stay hidden until configured                    |
| Healthcheck                   | `--health-cmd` in `ExtraParams`       | Probes both processes, the same pair as the compose healthcheck       |

Appdata can live on a cache-only `appdata` share as long as something backs it up (the Appdata
Backup plugin, or `scripts/backup.sh` from a User Script). The template pins no version beyond
`:latest`; change the Repository to a digest before upgrading, so the rollback is "start the
previous image", not "downgrade the schema".

Unraid sets `TZ` on every container, and the Convex backend refuses to start with it set. The
entrypoint unsets it for the backend only, so leave the GUI's timezone alone.

### First run on Unraid

The image carries the backend, not your functions, and the backend reads its own environment, not
the container's. `BETTER_AUTH_SECRET`, `SITE_URL` and `SELF_HOSTED` take effect once they are set
**in Convex**. `ALLOW_SIGNUP` is read twice: the `/signup` page checks the container's variable
(the template's **Allow signup** field) and redirects to `/signin` unless it is `true`, and the auth
server checks the Convex one. Bootstrap needs both. So once the container is healthy, from a checkout of this repository
on any machine that can reach the box:

```bash
# On the Unraid box: generate the admin key into a private file (outside the appdata volume;
# /root is RAM on Unraid, and the key can be regenerated any time).
docker exec -w /convex Ignidash ./generate_admin_key.sh | grep '|' | tail -1 > /root/.ignidash_admin_key
chmod 600 /root/.ignidash_admin_key

# From the checkout (substitute your box's address):
KEY="$(ssh root@<unraid-ip> cat /root/.ignidash_admin_key)"
URL=http://<unraid-ip>:3210
npx convex deploy --url "$URL" --admin-key "$KEY" -y
npx convex env set SELF_HOSTED true --url "$URL" --admin-key "$KEY"
npx convex env set SITE_URL http://<unraid-ip>:3030 --url "$URL" --admin-key "$KEY"
npx convex env set BETTER_AUTH_SECRET "<the same secret as the template>" --url "$URL" --admin-key "$KEY"
npx convex env set ALLOW_SIGNUP true --url "$URL" --admin-key "$KEY"
npx convex run migrations:runAll --url "$URL" --admin-key "$KEY"
```

Set **Allow signup** to `true` in the template and apply, then create your account at
`http://<unraid-ip>:3030/signup`. Lock signup again in both places: clear **Allow signup** and apply,
and `npx convex env remove ALLOW_SIGNUP --url "$URL" --admin-key "$KEY"`. Repeat `convex deploy` and
`migrations:runAll` after pulling a new image whose functions changed.

---

## AI access (MCP)

An AI client can read and edit your plans through the MCP endpoint at `http://<host>:3030/api/mcp`
(Streamable HTTP). It authenticates with a personal access token, not your password.

1. **Settings → AI access (MCP)**: name a token, choose **Read only** or **Read and write**, and
   create it. The token is shown once; only its hash is stored.
2. Connect the client with the command the page shows, for example:

   ```bash
   claude mcp add --transport http ignidash http://<host>:3030/api/mcp \
     --header "Authorization: Bearer ign_…"
   ```

3. Ask it to "run the setup_interview prompt", or use the tools directly.

| Tools                                                                    | Scope |
| ------------------------------------------------------------------------ | ----- |
| `list_plans`, `get_plan`, `get_schema`, `validate_plan`, `list_journal`  | read  |
| `analyze_plan` (the in-app chat's engine tools, batched in one call)     | read  |
| `create_plan`, `clone_plan`, `rename_plan`                               | write |
| `upsert_*` / `delete_*` for accounts, income, expenses, debts, property, | write |
| contribution rules; `update_*` for timeline, taxes, settings, SEPP, etc. |       |
| `add_journal_entry`, `update_journal_entry`, `delete_journal_entry`      | write |

- Every call runs the app's own validators and handlers as the token's owner, is written to the
  audit list on the settings page, and is limited to 120 calls a minute per token. **Revoke** stops
  a token at once.
- No tool deletes your account or all your data, or changes passwords or settings.
- The app still calls nothing outside. A cloud AI client (Claude) does send your plan data to its
  provider; a local model does not. Over plain HTTP the token crosses the LAN unencrypted;
  Tailscale encrypts it in transit.
- The tools live in `convex/mcp/`; the Next.js route (`src/app/api/mcp/route.ts`) only forwards to
  the Convex HTTP routes `/mcp/manifest` and `/mcp/tool`.

---

## Commands

| Command                             | Description                                                    |
| ----------------------------------- | -------------------------------------------------------------- |
| `npm run selfhost -- --init`        | First-time setup (creates `.env.local` from template)          |
| `npm run selfhost`                  | Rebuild, restart, regenerate the admin key, sync env, redeploy |
| `npm run selfhost -- --sync-only`   | Sync env vars to Convex without rebuilding                     |
| `npm run selfhost:convex-deploy`    | Deploy Convex functions only (exports a backup first)          |
| `bash scripts/backup.sh`            | Export the deployment to an age-encrypted, timestamped archive |
| `bash scripts/restore.sh ARCHIVE`   | Restore an archive into a deployment (destructive; guarded)    |
| `npm run docker:up` / `docker:down` | Start / stop the container                                     |
| `npm run docker:logs`               | Stream container logs                                          |

> **Note:** `npm run selfhost` generates a new Convex admin key on each run and saves
> it to `.env.local`. The previous key stops working.

---

## Environment variables

### Required

| Variable                       | Description                                                           |
| ------------------------------ | --------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`           | Encrypts auth sessions and JWKs                                       |
| `SITE_URL`                     | Public URL of the app, e.g. `http://192.168.1.100:3030`               |
| `NEXT_PUBLIC_CONVEX_URL`       | Convex API as seen by the browser, e.g. `http://192.168.1.100:3210`   |
| `NEXT_PUBLIC_CONVEX_SITE_URL`  | HTTP actions as seen by the browser, e.g. `http://192.168.1.100:3211` |
| `CONVEX_SELF_HOSTED_URL`       | Loopback URL for the CLI, always `http://127.0.0.1:3210`              |
| `CONVEX_SELF_HOSTED_ADMIN_KEY` | Generated by the setup script                                         |

### Set by `docker-compose.yml` — do not set these yourself

| Variable                      | Value                                            |
| ----------------------------- | ------------------------------------------------ |
| `SELF_HOSTED_CONVEX_URL`      | `http://127.0.0.1:3210`                          |
| `SELF_HOSTED_CONVEX_SITE_URL` | `http://127.0.0.1:3211`                          |
| `CONVEX_CLOUD_ORIGIN`         | same as `NEXT_PUBLIC_CONVEX_URL`                 |
| `CONVEX_SITE_ORIGIN`          | same as `NEXT_PUBLIC_CONVEX_SITE_URL`            |
| `DISABLE_BEACON`              | `true` — disables the backend's hourly telemetry |

### Optional

| Variable                                     | Description                                                                                                                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`   | Google sign-in. `NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED=true` must be set at **build** time — Next inlines it into the client bundle, so a runtime env var is not enough                                      |
| `OPENAI_API_KEY`                             | Enables AI chat and insights                                                                                                                                                                            |
| `OPENAI_BASE_URL`                            | Any OpenAI-compatible endpoint (Ollama, llama.cpp, vLLM, LM Studio)                                                                                                                                     |
| `OPENAI_ENDPOINT`                            | Azure OpenAI endpoint, used only when `OPENAI_BASE_URL` is unset                                                                                                                                        |
| `OPENAI_CHAT_MODEL`, `OPENAI_INSIGHTS_MODEL` | Model or deployment names                                                                                                                                                                               |
| `ALLOW_SIGNUP`                               | `true` unlocks account creation for bootstrap; anything else (including empty) locks it. Read by the auth server, so it must reach the Convex deployment — `npm run selfhost -- --sync-only` does that. |

AI features stay hidden until `OPENAI_API_KEY` and one of the endpoints is set.

### Backups

Read by `scripts/backup.sh` (and by the export gate inside `npm run selfhost`).
They work from the environment or from `.env.local`; relative paths in
`.env.local` resolve against the repository root.

| Variable                            | Description                                                                                                                                        |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGE_RECIPIENT`                     | age public key the archives are encrypted to. Encryption is on by default and the script refuses to write a plain ZIP without an explicit opt-out. |
| `AGE_RECIPIENTS_FILE`               | File of age public keys (equivalent to `age -R`).                                                                                                  |
| `AGE_IDENTITY_FILE`                 | age identity file; `scripts/backup.sh` derives its recipient, `scripts/restore.sh` decrypts with it.                                               |
| `IGNIDASH_BACKUP_DIR`               | Where archives are written. Default: `./backups` inside the repository. Use an array share on Unraid, not the cache pool.                          |
| `IGNIDASH_BACKUP_KEEP_NIGHTLY`      | Newest `N` archives kept. Default `30`.                                                                                                            |
| `IGNIDASH_BACKUP_KEEP_MONTHLY`      | Newest archive of each of the `N` most recent months kept. Default `12`.                                                                           |
| `IGNIDASH_BACKUP_ALLOW_UNENCRYPTED` | `1` writes a plaintext archive. Only for a deliberate, one-off decision — never leave it set in `.env.local`.                                      |

### Removed — these no longer do anything

`STRIPE_*`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `RESEND_API_KEY`,
`NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST`, `CONVEX_API_SECRET`. Billing,
transactional email, analytics and the internal API secret have been removed from this fork.

---

## Choosing the URLs

All three public values must be reachable **from the machine running the browser**,
not just from the host:

```dotenv
SITE_URL=http://192.168.1.100:3030
NEXT_PUBLIC_CONVEX_URL=http://192.168.1.100:3210
NEXT_PUBLIC_CONVEX_SITE_URL=http://192.168.1.100:3211
CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210
```

`CONVEX_CLOUD_ORIGIN` / `CONVEX_SITE_ORIGIN` are what the backend **advertises** to
clients; internal routing always uses loopback. If they point somewhere the browser
cannot reach, uploads and auth callbacks fail.

### Reverse proxy

| Public URL                    | Target  | Notes                                    |
| ----------------------------- | ------- | ---------------------------------------- |
| `https://app.example.com`     | `:3030` | Ignidash app                             |
| `https://api.example.com`     | `:3210` | Convex API — **needs WebSocket support** |
| `https://actions.example.com` | `:3211` | Convex HTTP actions                      |

Nginx needs `proxy_set_header Upgrade $http_upgrade` and
`proxy_set_header Connection "upgrade"` on the 3210 host. Caddy and Traefik handle
this automatically.

---

## Account creation and password reset

One operator account, reachable only on the LAN. Signup is **locked by default**:
`emailAndPassword.disableSignUp` is `true` unless `ALLOW_SIGNUP` is exactly `true`. Better-Auth
enforces that on the server — `/sign-up/email` is refused with "Email and password sign up is not
enabled" even if someone posts to it directly — and a user-creation hook stops providers that
bypass that check (a configured Google sign-in). The app also redirects `/signup` to `/signin` and
hides the "Create an account" link, so a visitor is never led to a form that will fail.

### Bootstrap (create-then-lock)

1. In `.env.local`, set `ALLOW_SIGNUP=true` and restart the container
   (`docker compose up -d`).
2. Open `{SITE_URL}/signup` and create the operator account.
3. Clear the line (`ALLOW_SIGNUP=`) and apply the lock:
   `npm run selfhost -- --sync-only`.
   That removes `ALLOW_SIGNUP` from the Convex deployment, so the lock is real even though the
   container still runs. (Without the repo checkout: `npx convex env remove ALLOW_SIGNUP --url
$CONVEX_SELF_HOSTED_URL --admin-key $CONVEX_SELF_HOSTED_ADMIN_KEY`.)

Re-open signup the same way only if you genuinely need a second account.

### Break-glass password reset (no mail transport)

There is no email delivery, so the reset link goes to the container log instead:

1. Open `{SITE_URL}/forgot-password` and submit the account's email address.
2. On the Unraid console, read the link out of the log:

   ```bash
   docker logs ignidash 2>&1 | grep ignidash-auth
   ```

   It looks like
   `[ignidash-auth] password reset for you@example.com: http://192.168.1.100:3030/reset-password?token=… (single use, expires in 15 minutes)`.

3. Open the link within 15 minutes and choose a new password. `/reset-password` completes the
   reset and signs out every other session.

Properties of the token: random (Better-Auth generates it), stored as a verification record,
**expires after 15 minutes**, and **single use** — the record is deleted on the first successful
reset, so a second attempt fails with "Invalid token". Submitting the form for an address that
does not exist returns the same generic message and writes nothing.

**The reset URL is a credential.** Anyone who can read the container log can take over the
account until it expires or is used:

- treat the line like a password — do not paste it into chat, tickets or screenshots;
- use it promptly; if it has been exposed, request a new one and use that (the old one stays valid
  until it is used or expires, so prefer using the new one);
- the container logs rotate (`max-size: 10m`, three files), so old lines do not live forever, but
  rotation is not a security control — the 15-minute TTL and single use are.

Both the route guard and the lock are covered by tests; see `convex/utils/auth_hardening.test.ts`
and `src/app/(auth)/signup/page.test.ts`.

### LAN only — the standing rule

The instance is meant for the LAN, or for remote access through Tailscale (whose own login gates
it). **Exposing it beyond that — a public reverse proxy, Tailscale Funnel, port forwarding —
requires the Better-Auth `twoFactor()` plugin with backup codes first.** That is deliberately not
built (decision F5/D7): with one account there is no admin role to gate anything, and TOTP adds
little while the app is not reachable from the internet. Turn it on before you change that.

## Backups and restore

Convex's deploy and migrations are one-way, so an export is the only rollback path.
Two scripts cover it, and both are safe to run without a TTY. They need `node` (the
Convex CLI runs from `node_modules`), `unzip` to inspect archives, and `age` unless
encryption is opted out of.

`npm run selfhost` runs the export **before** it recreates the container, so the
rollback point always predates the backend's on-start migrations.

| Script                        | What it does                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------------- |
| `bash scripts/backup.sh`      | Exports the deployment to `ignidash-<UTC timestamp>.zip.age`, then prunes old archives |
| `bash scripts/restore.sh ...` | Imports an archive into a deployment (destructive, guarded)                            |

### Encrypting the archive

Encryption with [age](https://github.com/FiloSottile/age) is **on by default**, and the
script refuses to write a plain ZIP unless it is told to. One access method is enough:

```bash
# 1. Create a key once. Keep the identity somewhere you will still have it after
#    the server dies — it is the only way to read the archives.
age-keygen -o ~/.keys/ignidash-backup.txt

# 2. Give the archive script the public half only.
#    Put this in .env.local so npm run selfhost uses it too:
export AGE_RECIPIENT=$(age-keygen -y ~/.keys/ignidash-backup.txt)
```

`AGE_RECIPIENTS_FILE=recipients.txt` (several recipients) and
`AGE_IDENTITY_FILE=backup-key.txt` also work. A restore **without** the identity
fails, which is the point: the archives are unreadable without the key.

The identity must be **unencrypted**: `scripts/backup.sh` derives the recipient with
`age-keygen -y`, and that prompts for a passphrase on a TTY, which a nightly cron run
cannot answer. Do not create it with `age-keygen -p`; the script detects such a file
and refuses it immediately instead of hanging.

The plaintext escape hatch is `--allow-unencrypted` (or
`IGNIDASH_BACKUP_ALLOW_UNENCRYPTED=1`), which permits a plain ZIP **when no recipient
is configured**. A configured recipient always encrypts, so the flag cannot silently
weaken a configured setup. Use it once if you truly must, never as a default.

After every export the archive is inspected: it must be a readable Convex snapshot that
contains the `plans` table. A stub, a ZIP of something else, or a snapshot of a
different schema fails the backup, and with it the deploy gate. Two explicit escapes
cover the cases a check cannot judge:

- `--expect-empty` accepts a snapshot with no table data. Only the fresh-install path
  (`npm run selfhost -- --init` on an empty volume, which gates before the first
  deploy) passes it, because there is nothing to roll back yet.
- `--skip-snapshot-check` skips the inspection entirely. It exists so a legitimate
  deployment the checks misjudge cannot lock the operator out of their own deploy,
  and it also lets a corrupt or foreign archive through, so use it knowingly.

### Retention

The script keeps the newest **30** archives plus the newest archive of each of the
last **12** calendar months (UTC) — the nightly-plus-monthly policy. Only archives
named `ignidash-<8-digit date>T<6-digit time>Z.zip[.age]` are eligible: anything else
in the directory, such as a hand-made `ignidash-pre-migration.zip`, is never pruned.
An archive is never overwritten either — re-running in the same second is a no-op.
Tune retention with `--keep-nightly`, `--keep-monthly` or `--no-prune`, or set
`IGNIDASH_BACKUP_KEEP_NIGHTLY` / `IGNIDASH_BACKUP_KEEP_MONTHLY` in `.env.local` (a flag
wins over the file). Every one of those settings is read the same way regardless of
which path runs the backup, including the export gate inside `npm run selfhost`.

### Scheduling on Unraid

Use the **User Scripts** plugin. It has a cron scheduler and no systemd, which is
exactly the Unraid model.

Prerequisites on the box (User Scripts cron runs with a minimal `PATH`):

- `node` and `npm` — the Convex CLI runs from the repository's `node_modules`
- `age` and `age-keygen` — install from **NerdTools** in Community Applications
- `unzip` — the export is inspected before it is accepted

Write the archives to a **normal array share**, for example
`/mnt/user/backups/ignidash`, and **never** to the cache pool that holds the
`convex-data` appdata (`/mnt/cache/appdata/...`). A cache-only copy is lost when the
pool is rebuilt or the cache drive fails, which is the situation the backup exists
for. Because the array share is on the encrypted array, the archives are also
encrypted at rest; the age layer protects the copy once it leaves the box.

The repository ships the entry: **`unraid/user-scripts/ignidash-backup.sh`**. Paste it into
**User Scripts → Add New Script**, set `REPO_DIR` if you cloned somewhere other than
`/mnt/user/appdata/ignidash`, save, then schedule it (Daily, or custom `0 3 * * *`). It exports the
cron `PATH` itself, writes to `/mnt/user/backups/ignidash` and hands off to `scripts/backup.sh`, so
a failed export shows up as a failed run instead of a silent one.

```bash
#!/bin/bash
# The shape of that script; see unraid/user-scripts/ignidash-backup.sh for the real one.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
REPO_DIR=/mnt/user/appdata/ignidash
export IGNIDASH_BACKUP_DIR=/mnt/user/backups/ignidash
export AGE_RECIPIENT=age1...              # or AGE_IDENTITY_FILE=/root/.keys/ignidash-backup.txt
cd "$REPO_DIR" && exec bash scripts/backup.sh
```

The script reads `CONVEX_SELF_HOSTED_URL` / `CONVEX_SELF_HOSTED_ADMIN_KEY` from
`.env.local`, and the repository needs `npm install` run once. It exits non-zero on
any failure, so User Scripts shows a failed run instead of a silent one.

### Restore drill

Run this before you need it, and after any upgrade that changed the schema. It proves
the archive is readable, complete, and importable.

```bash
# 1. Export.
bash scripts/backup.sh

# 2. Start a scratch deployment to wipe. A second compose project on other ports is
#    the least intrusive way, or use any throwaway Convex self-hosted backend.
#    Point the CLI at it with its own URL and admin key.
SCRATCH_URL=http://127.0.0.1:3212
SCRATCH_KEY=<admin key of the scratch deployment>

# 3. Wipe it: stop the scratch backend and delete its data directory, then start it
#    again and deploy functions so the schema exists.

# 4. Import the latest archive into the scratch deployment.
bash scripts/restore.sh "$(ls -t /mnt/user/backups/ignidash/ignidash-*.zip.age | head -1)" \
  --url "$SCRATCH_URL" --admin-key "$SCRATCH_KEY" \
  --identity ~/.keys/ignidash-backup.txt \
  --confirm "$SCRATCH_URL" --yes

# 5. Verify. The script prints a per-table document count and fails when the
#    deployment holds fewer documents than the archive does. Cross-check by hand:
npx convex data plans --limit 1 --url "$SCRATCH_URL" --admin-key "$SCRATCH_KEY"
```

A drill is green when the import succeeds and the plan you expect comes back. Then
destroy the scratch deployment.

### Restoring for real

The same command, pointed at the live deployment, is the recovery procedure:

```bash
bash scripts/restore.sh /mnt/user/backups/ignidash/ignidash-<timestamp>.zip.age \
  --identity ~/.keys/ignidash-backup.txt \
  --confirm "$CONVEX_SELF_HOSTED_URL"
```

The guards are deliberate: `--confirm` must be the exact target URL, an interactive
run also asks you to type `RESTORE`, a non-loopback target additionally needs
`--allow-non-loopback`, and a non-TTY run needs `--yes`. Restore into the **previous**
image's deployment rather than downgrading a schema in place.

---

## Encryption at rest

**Decision (P5.5, D6): two layers, and no third.**

1. **Host disk encryption** for everything Ignidash stores — the Unraid array or pool holding
   `/mnt/user/appdata/ignidash` (the `convex-data` appdata) _and_ the backup share
   `/mnt/user/backups/ignidash`. Unraid covers this with LUKS (encrypted array devices), encrypted
   XFS/Btrfs pools, or native ZFS encryption.
2. **age encryption for archives**, which `scripts/backup.sh` applies by default: with no recipient
   configured it refuses to run at all — before exporting — rather than write a plaintext ZIP, and
   only `--allow-unencrypted` (or `IGNIDASH_BACKUP_ALLOW_UNENCRYPTED=1`) permits one (see
   [Encrypting the archive](#encrypting-the-archive)). A configured recipient always wins over that
   opt-out.

App-level field encryption is deliberately **not built**. That is a decision with reasons, not a
gap waiting to be filled — the reasons are at the end of this section.

### Residual risks

Disk encryption protects data **at rest on a powered-off disk**. It does not protect against:

- **A running, unlocked array.** Anyone who reaches the app over the LAN, or gets a shell on the box
  while the array is mounted, reads plaintext. That is what the LAN/Tailscale boundary and the
  signup lock are for, not the disk encryption.
- **A keyfile stored beside the array.** Convenient for unattended reboots, but then disk theft and
  server theft are the same event.
- **A compromised host.** The OS, the backend, the container and `.env.local` itself (admin key,
  `BETTER_AUTH_SECRET`, AI keys) are readable from the host. Encryption at rest cannot defend
  against a host that is running and trusted to decrypt.
- **A copy taken off the array without its own encryption.** A `cp -r` of the appdata directory, a
  VM/volume snapshot, or a share synced to the cloud is plaintext unless that destination encrypts.
  Only archives written by `scripts/backup.sh` carry age — prefer those for anything leaving the
  box.

### Encrypted arrays and unattended reboots

An encrypted array needs its passphrase or keyfile **at array start**. Consequences:

- **Reboot without a keyfile → the array does not mount →** `/mnt/user/appdata/ignidash` is missing,
  the container cannot start, and the app is down until someone enters the passphrase.
- **The nightly backup cron runs into the same wall.** A User Scripts backup on a box that rebooted
  unattended with no keyfile fails every night until the array is unlocked, and User Scripts only
  reports that if you look (or have notifications on). A backup that quietly stops is worse than no
  schedule: check the last-run status after any unattended reboot.
- With a keyfile on the boot device, reboots are unattended again — but the keyfile is then part of
  what protects the data, so it must not live on the array it unlocks.

The check for this whole decision is the restore drill's negative case: without the identity, an
`.age` archive will not decrypt (`scripts/restore.sh` refuses it, and `age` would fail anyway);
with the identity, the [restore drill](#restore-drill) passes.

### Why app-level field encryption is not built

Considered and rejected (P5.5; `PLAN-parity.md` §5 records it as "won't fix, by decision"):

- **The key would sit next to the data.** Convex functions run server-side, so anything they can
  decrypt lives in the same container as the database and in the same `.env.local` as the admin key.
  An attacker with host access gets both. The threat field encryption pretends to solve is already
  covered by the encrypted disk; the threats it does not cover are the ones that matter.
- **It would break the app's own contracts.** Convex validators describe plaintext shapes, and
  indexes, snapshots/undo and the import/export envelope all assume readable values. Encrypted blobs
  would need parallel schemas, and snapshots would stop being diffable and restores would become
  all-or-nothing.
- **It would break server-side AI.** Chat and insights build prompts on the server, so the key would
  have to be in prompt-building code (same box, same risk) or the features would go away.
- **It needs a one-way plaintext backfill** for existing rows: a migration with no rollback.

If the threat model changes — the box leaves your physical control, or you expose it beyond the LAN
— the answer is stronger access control and transport, not field crypto running on the server that
holds the key.

**Related decision (F5, P5.6):** there is no PWA/service-worker offline shell, because a service
worker needs a secure context and this deployment is plain HTTP on the LAN; remote access, if
wanted, is Tailscale, whose own login gates it. The standing rule is unchanged: **exposing the app
beyond the LAN and Tailscale requires the `twoFactor()` plugin with backup codes first.**

---

## Updating

`npm run selfhost` is the whole upgrade once the digest is bumped: it exports the
running deployment first, then rebuilds, restarts, syncs env, deploys functions and
runs migrations. An abort at the export means nothing has been rebuilt or restarted
yet.

```bash
# 1. Bump CONVEX_IMAGE in the Dockerfile to a newer digest
npm run selfhost
```

The export happens **before** the container is recreated, because the backend
applies in-place migrations when it starts — an export taken afterwards would
already be post-migration. If the container is stopped there is nothing to export
from: start the current image (`npm run docker:up`), then run `npm run selfhost`
again.

By hand, the same order applies — export first:

```bash
bash scripts/backup.sh
# bump CONVEX_IMAGE in the Dockerfile to a newer digest
docker compose build
docker compose up -d
npm run selfhost -- --sync-only
npm run selfhost:convex-deploy
```

`npm run selfhost`, `npm run selfhost -- --init` and `npm run selfhost:convex-deploy` all
run `scripts/backup.sh` before they deploy functions or run migrations, and **abort if
the export fails**. The last one is `bash scripts/selfhost.sh --deploy-only`: the same
deploy and the same gate, without the container rebuild, the admin-key rotation or the
migrations.

`--init` re-run on an existing install behaves the same way: a non-empty
`CONVEX_SELF_HOSTED_ADMIN_KEY` in `.env.local` marks the install as pre-existing even
when its container is down, so the export is attempted first and a stopped container
aborts with the "start the CURRENT image first" instruction instead of being rebuilt
past the gate.

Two entry points are **not** gated, by design:

- `npm run selfhost:convex-dev` runs the `convex dev` watcher, which pushes functions on
  every edit — a backup per save would be noise. Export before starting it on an install
  you care about.
- `npm run docker:up` starts the container, and the backend applies its on-start
  migrations as it boots. It is the right way to bring a stopped install back up _before_
  exporting (see above), but it is not a substitute for the export itself.

The backend applies in-place migrations on start, so **rolling it back is unsafe**.
That is why the image is pinned by digest rather than tracking `:latest`. Export
before every upgrade, and keep the restore drill green.

---

## Database migrations

Migrations run through `@convex-dev/migrations`. `scripts/selfhost.sh` calls `migrations:runAll`
after a failed-closed export (see [Updating](#updating)), and `npm run selfhost -- --sync-only`
does not run them at all.

The policy, in order of importance:

1. **Append-only.** A new migration is added to the end of `runAll` in `convex/migrations.ts`. An
   entry that has ever shipped is never removed or reordered: a deployment that already ran it
   would skip it, and one that has not would run it out of order.
2. **Idempotent.** Running a migration twice must leave documents byte-identical. The simplest way
   is what `backfillOwnerAndHousehold` does: compute a patch, return `undefined` when there is
   nothing to write, and never overwrite a field that is already set.
3. **Expand/contract.** Add the new field or table first and make readers default to it
   (`owner ?? 'primary'`, "missing household means one person"), ship that, migrate the data, and
   only remove the old path in a later release. A migration never changes a number: if the reader
   default and the migrated value disagree, the migration is wrong.
4. **Fail closed.** `runAll` is only reached after an export succeeded, so the pre-migration state
   is always restorable. An export failure aborts the upgrade instead of migrating without a
   rollback point.

`backfillOwnerAndHousehold` is the worked example: it backfills `owner`/`propertyRegime`/`household`
on plans written before households existed, skips anything a user already tagged, skips
`planSnapshots` (rewriting history would make a restored snapshot differ from what was stored), and
is a no-op on a second run. Its readers had already defaulted, so it moved no numbers.

## No dashboard

The Convex dashboard is not shipped. Everything it did has a CLI equivalent. Two
spellings work for every command below; this file uses `--env-file` for consistency
with the scripts, not because the other form is broken.

```bash
npx convex data <table> --env-file .env.local
npx convex logs        --env-file .env.local
npx convex env list    --env-file .env.local
npx convex run <fn>    --env-file .env.local
```

`--env-file .env.local` reads `CONVEX_SELF_HOSTED_URL` and
`CONVEX_SELF_HOSTED_ADMIN_KEY` from the file. The equivalent explicit form is
`npx convex data <table> --url "$CONVEX_SELF_HOSTED_URL" --admin-key
"$CONVEX_SELF_HOSTED_ADMIN_KEY"`; those two flags are accepted (verified against
CLI 1.32.0) but hidden from `--help`, so the `--env-file` form is the one to rely on
in notes and scripts. Exporting both variables before the command is a third,
equivalent form.

### "Failed to decrypt private key"

This means `BETTER_AUTH_SECRET` changed while encrypted JWKs remained in the
database. Without a dashboard the supported fixes are:

1. **Fresh deployment** — stop the container, delete `/convex/data`, start again.
2. **Restore from a known-good export** —
   `bash scripts/restore.sh <archive> --confirm "$CONVEX_SELF_HOSTED_URL"`
   (see [Backups and restore](#backups-and-restore)).

There is no self-service table editor. Treat `BETTER_AUTH_SECRET` as immutable.

---

## Troubleshooting

### Container is unhealthy

```bash
docker compose ps
docker compose logs --tail=100 ignidash
```

The healthcheck requires **both** processes: `127.0.0.1:3210/version` (backend) and
`127.0.0.1:3000/api/health` (app). A dead backend shows as an unhealthy container.
`/api/health` answers `{"status":"ok","version":"<package version>","uptime":<seconds since the app
process started>}`, so a restart is visible as a small `uptime` and a hang as a climbing one:

```bash
curl -s http://127.0.0.1:3030/api/health
```

`version` comes from the image's `package.json`, not a hand-written string, so it changes when you
upgrade or roll back.

Startup order is handled inside the entrypoint — it waits for `/version` before
starting Next.js, so an early `502` usually means the backend never came up.

### Port conflicts

| Port | Service             |
| ---- | ------------------- |
| 3030 | Ignidash app        |
| 3210 | Convex backend API  |
| 3211 | Convex HTTP actions |

Node.js 22 is also required on the host for the CLI; the container ships its own.

### Missing environment variables in Convex

```bash
npx convex env list --url http://127.0.0.1:3210 --admin-key <key>
npm run selfhost -- --sync-only
```

---

## Known limitations

- **No email delivery.** Password recovery works without one: `/forgot-password` writes the
  reset link to the container log (see [Account creation and password reset](#account-creation-and-password-reset)).
  If the container log is gone, restore a backup with `scripts/restore.sh`.
- **No billing, analytics, or email.** Deliberate — see
  `PLAN-single-container-offline.md`.
- **Single container means shared fate.** Restarting the container restarts both
  processes; there is no way to restart only the backend.

## Convex self-hosting documentation

- [Self-Hosting Overview](https://docs.convex.dev/self-hosting)
- [Hosting on Own Infrastructure](https://github.com/get-convex/convex-backend/blob/main/self-hosted/advanced/hosting_on_own_infra.md)
- [Upgrading](https://github.com/get-convex/convex-backend/blob/main/self-hosted/advanced/upgrading.md)
