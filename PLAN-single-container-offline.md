# Plan: One container, zero third-party egress

> **Status:** Approved 2026-10-29 — implementation in progress
> **Date:** 2026-10-29
> **Scope:** Self-hosted deployment (Unraid), not the cloud/Vercel path

---

## 1. Goal / Context

Two goals, one plan because they share the same container and the same env surface.

**Goal 1 — one container instead of three.** Today the self-hosted stack is
`convex-backend` (3210/3211) + `convex-dashboard` (6791) + `app` (3000)
(`docker-compose.yml:2-67`). Target: a single image, single service, single
`docker compose up`, with the Convex backend running as a supervised child
process of the app container.

**Goal 2 — no outside dependencies or network calls.** The app currently talks to
PostHog, Vercel Analytics, Stripe, Google OAuth, Resend, Azure OpenAI, Google
Fonts and Google avatar hosting. Target: the containerized app makes **zero**
outbound connections to third-party hosts at runtime, and the build is
runtime. Build-time dependencies (npm registry, base images) are explicitly out of
scope by your choice — see §7.

### Why these two together

Co-locating Convex (Goal 1) already removes the single largest egress surface —
today the browser dials `NEXT_PUBLIC_CONVEX_URL` and the server dials
`SELF_HOSTED_CONVEX_URL` across the Docker network and out to the host. Once the
backend is in the same container, all Convex traffic is loopback. What remains
is a short, enumerable vendor list (Goal 2).

### The boundary — what cannot be removed

| Component                      | Why it stays                                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Next.js 16 + React 19          | The app _is_ an App Router tree; `output: 'standalone'` + `node server.js` is the runtime (`next.config.ts:9`, `docker-entrypoint.sh:44`). |
| Convex client + server runtime | Every page and hook uses `convex/react`; all backend logic is `convex/*.ts`. Self-hosting keeps the protocol, not a substitute for it.     |
| better-auth                    | Session/JWT plumbing behind every authenticated route (`src/lib/auth-server.ts`, `convex/betterAuth/*`).                                   |
| Tailwind 4                     | Build-time CSS toolchain.                                                                                                                  |
| npm registry, Docker Hub, GHCR | Required to _build_ — addressable via mirror/cache/pinning, not elimable.                                                                  |

"Free of outside dependencies" therefore means: **no vendor service required at
runtime, no vendor SDK in the request path, and a build that works from a
pinned local cache.** Replacing Next or Convex is a rewrite, not a task — see
§7.

---

## 2. Decisive facts (from reconnaissance)

| Fact                                                                                                                                                                                 | Evidence                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Convex backend image is `ubuntu:noble` (glibc 2.39), runs as **root**, `WORKDIR /convex`, `ENTRYPOINT ./run_backend.sh`, `EXPOSE 3210 3211`, `VOLUME /convex/data`                   | upstream `self-hosted/docker-build/Dockerfile.backend`                                                   |
| The image path in this repo's compose (`ghcr.io/get-convex/...`) **does not exist** — GHCR returns 403 for both token and manifest. The live path is `ghcr.io/convex/convex-backend` | verified against `ghcr.io/v2/.../manifests/latest`; digest `sha256:207cf95d…644fa`                       |
| Backend handles **SIGINT only** (no SIGTERM handler); no `USER` directive; `run_backend.sh` only `mkdir -p`, never `chown`                                                           | upstream `run_backend.sh`, `crates/local_backend/src/main.rs`                                            |
| App image is `node:22-alpine` (musl) and drops to uid 1001 `nextjs`                                                                                                                  | `Dockerfile:2,12,41,47-49,66`                                                                            |
| `NEXT_PUBLIC_*` URLs are **baked at build time** by CI with `localhost` defaults, then text-patched at container start                                                               | `.github/workflows/docker-publish.yml:63-65`, `docker-entrypoint.sh:5-38`                                |
| `convex/` sources + CLI are **not** in the image; deploy runs from the host via `npx convex deploy --url … --admin-key …`                                                            | `Dockerfile:59-64`, `scripts/selfhost.sh:237-239`                                                        |
| Admin key is a pure local derivation (`keygen admin-key --instance-name --instance-secret`) — no network                                                                             | upstream `crates/local_backend/src/main.rs`; `generate_admin_key.sh`                                     |
| Dashboard is **not** required for deploy or runtime                                                                                                                                  | upstream `test_self_hosted_backend.yml` runs push + HTTP actions with backend only                       |
| `CONVEX_CLOUD_ORIGIN` / `CONVEX_SITE_ORIGIN` are **advertised** origins only; internal routing is `127.0.0.1`                                                                        | upstream `crates/local_backend/src/{config,proxy}.rs`                                                    |
| Backend phones home hourly to `api.convex.dev/api/self_host_beacon` unless `DISABLE_BEACON`                                                                                          | upstream `crates/local_backend/src/beacon.rs`                                                            |
| `next.config.ts` rewrites `/ingest/*` → `us.i.posthog.com` **unconditionally**, ignoring `NEXT_PUBLIC_POSTHOG_HOST`                                                                  | `next.config.ts:26-37`                                                                                   |
| `next/font/google` fetches 3 families at build time; no local font files exist in `public/`                                                                                          | `src/app/layout.tsx:3,12-27`                                                                             |
| `scripts/selfhost.sh` syncs `CONVEX_VARS` but **omits `CONVEX_SITE_URL`**, which `convex/auth.ts:156,447,458,474` read                                                               | `scripts/selfhost.sh:186-200`                                                                            |
| `@better-auth/telemetry` ships in the lockfile with no disable config                                                                                                                | `package-lock.json:5245,5334-5338`                                                                       |
| `createCustomerOnSignUp: true` runs with a stub `{} as Stripe` client when Stripe is unset — may abort email signup                                                                  | `convex/auth.ts:34-38,172-183`                                                                           |
| AI usage limiting is keyed on subscription type + start time, not just the billing UI                                                                                                | `convex/utils/ai_utils.ts:53-62,114-142`; `convex/messages.ts:56-58,146-154`; `convex/insights.ts:69-93` |

---

## 3. Design

### 3.1 Goal 1 — one container

**D1. Final stage is based on the Convex image, not on Node.**
`FROM ${CONVEX_IMAGE}` (pinned by digest) as the runner, then copy Node 22
from `node:22-bookworm-slim` into `/usr/local`. Rationale: the backend binary is
glibc-linked against noble (2.39); it cannot run on musl (alpine) or on
bookworm (2.36). Basing on the backend image also inherits `curl`,
`ca-certificates`, `libclang1` and Node's presence for `"use node"` actions.

**D2. Build stages move alpine → bookworm-slim.**
`Dockerfile:2,12,41` are `node:22-alpine`. `next/image` with remote patterns
(`next.config.ts:11-23`) needs `sharp` at runtime, and `.next/standalone`
carries the sharp binary built for the _builder's_ libc. Building on musl and
running on glibc breaks image optimization. Moving all stages to glibc also
removes the "no bash / no curl" problem that `generate_admin_key.sh` and the
`/version` probe would otherwise hit (`Dockerfile:6` adds only
`libc6-compat`).

**D3. Two processes, `tini` as PID 1, explicit signal routing.**
Entrypoint starts the backend, then the app, then traps: `SIGINT` → backend
(its only handled signal), `SIGTERM` → node, `wait`, reap. The backend spawns an
uncapped `node local.cjs` executor child, so a real init is required — a bare
`exec node server.js` (`docker-entrypoint.sh:44`) cannot be kept.

**D4. Publish 3000, 3210, 3211 from the one container.**
The browser dials the Convex API directly over WebSocket
(`src/app/convex-client-provider.tsx:9`), so 3210 must stay reachable. Origins
stay **public** URLs even though the backend binds inside the container. A
single-port variant (proxy Convex through Next) is deferred — Next rewrites do
not proxy WebSocket upgrades reliably, so it would need a sidecar proxy.

**D5. Data volume unchanged: `/convex/data`.**
SQLite + file storage + `credentials/{instance_name,instance_secret}` live
there. Backend stays root (it is the only writer); the app keeps uid 1001 and
pre-creates `.next` as today (`Dockerfile:54-56`). Do not attempt to chown
`/convex/data` — that is the documented path to `SQLITE_READONLY_DIRECTORY`.

**D6. Function deployment stays host-side.**
`npx convex deploy --url http://127.0.0.1:3210 --admin-key …` unchanged; only
the exec target changes (`convex-backend` → the merged container, `-w /convex`).
Rejected alternative: ship `convex/` + CLI + `node_modules` into the image and
self-deploy on boot — needs a runtime npm install and an admin-key bootstrap
story that does not exist today (`scripts/selfhost.sh:157`).

**D7. Startup ordering moves into the entrypoint.**
Compose's `depends_on: service_healthy` (`docker-compose.yml:42-44`) disappears
with the split. The entrypoint polls `http://127.0.0.1:3210/version` with
backoff before starting node. `/api/health` (`src/app/api/health/route.ts:1-3`,
currently a constant `{status:'ok'}`) is extended to probe `/version` and return
503, so the single healthcheck reflects both processes.

**D8. Keep the URL patching, add an assertion.**
CI bakes `http://localhost:3210` (`.github/workflows/docker-publish.yml:63-65`);
`docker-entrypoint.sh:12-38` sed-patches server and client bundles at start.
Keep it, and add a startup assert that the patched client bundle actually
contains the configured public URL — silent SPA breakage otherwise.

**D9. Pin the backend image by digest.**
The backend runs in-place migrations at startup; rolling the image back to an
older backend is unsupported. `:latest` (`docker-compose.yml:3,24`) makes that
accident available on every host reboot. Pin, and document
`npx convex export` before upgrades.
Resolved: `ghcr.io/convex/convex-backend@sha256:207cf95def42f01614b6e3af0af5c20d0dcaa5ff2adf258ee7bc9555576644fa`

**D10. Dashboard is dropped entirely.**
Not shipped in any profile. Consequence: the documented `betterAuth_jwks` repair
(`SELF_HOSTING.md:145-149`) becomes a CLI procedure, and every dashboard-only
task (logs, tables, env, scheduled functions) is documented as
`npx convex logs|data|env|run|export`. Compensating control for losing the UI's
visibility: the backend image is digest-pinned (D9) and `npx convex export` is
the documented pre-upgrade step.

### 3.2 Goal 2 — no third-party egress

Posture: **delete what is pure observation, gate what is optional product, and
keep only what can be pointed at your own infrastructure.**

| Service                   | Verdict                          | Rationale                                                                                                                                                                                                                                                                                 |
| ------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PostHog** (~50 sites)   | **Delete**                       | Observation only; largest call surface; `/ingest` rewrites (`next.config.ts:26-37`) leak to US PostHog regardless of env. Removes `posthog-js`, `posthog-node`, `src/lib/posthog-server.ts` (dead), `cookie-banner.tsx`.                                                                  |
| **Vercel Analytics**      | **Delete**                       | `@vercel/analytics` `track()` in 11 files + `<Analytics/>` (`src/app/layout.tsx:158`). No value outside Vercel.                                                                                                                                                                           |
| **Stripe**                | **Delete**                       | Chosen. Not just UI: the plugin (`convex/auth.ts:172-183`), the stub client (`:34-38`), the subscription reads (`:523-562`), `src/lib/auth-client.ts:4`, and the auto-generated `subscription` table all go. The usage limiting keyed on subscription type must be collapsed first (D14). |
| **Google OAuth**          | **Gate**                         | Provider is already conditional server-side; only the button (`google-sign-in.tsx:19-26`) and the avatars are not. Email/password is fully local (`convex/auth.ts:54-55`).                                                                                                                |
| **Resend**                | **Delete**                       | Chosen (recovery dropped): every send is a reset / verification / trial email, so the whole subsystem goes — `@convex-dev/resend`, its config entry (`convex/convex.config.ts:3,8`), 10 `sendEmail` sites, and the `forgot-password` / `reset-password` routes.                           |
| **Azure OpenAI**          | **Keep, make provider-agnostic** | Isolated to `convex/use_openai.ts`, reached by exactly two scheduler calls (`messages.ts:106`, `insights.ts:88`). Add `OPENAI_BASE_URL` so it can target a local OpenAI-compatible server; hide the UI when unconfigured.                                                                 |
| **Convex**                | **Keep**                         | Now in-container. Set `DISABLE_BEACON=true`; convert the four self-HTTP calls (`convex/auth.ts:156,447,458,474`) to direct internal function calls, removing the `CONVEX_SITE_URL` dependency.                                                                                            |
| **Google Fonts**          | **Deferred**                     | Build-time only, no runtime egress — out of scope under your choice. The 30-minute fix is `next/font/local` + vendored woff2 if you later want offline builds.                                                                                                                            |
| **Google avatars**        | **Replace**                      | Initials/identicon in `sidebar-auth.tsx:30`, `mobile-header.tsx:54`, `ai-chat-drawer.tsx:176`; drop `lh3.googleusercontent.com` from `remotePatterns`.                                                                                                                                    |
| **better-auth telemetry** | **Disable**                      | Present in the lockfile with no opt-out configured.                                                                                                                                                                                                                                       |

**D14. Removing billing means removing AI usage accounting.**
No UI renders tokens or cost — `recordUsage`, `checkUsageLimits` and
`calculateTokenCost` are backend-only (`convex/utils/ai_utils.ts:35-112`), so the
accounting has no user-visible surface worth preserving. Remove `recordUsage`,
`checkUsageLimits`, `getSubscriptionInfo` and `calculateTokenCost`; that also
drops the `subscriptionStartTime` / `subscriptionType` parameters from the
scheduler payloads in `convex/messages.ts:56-58,146-154` and
`convex/insights.ts:69-93`. Keep `getCanUseAIFeatures` (`:114-121`) — the only
piece the UI depends on — and redefine it as "is AI configured?" rather than
"is the user subscribed?".

**D15. Fresh deployment, existing volume wiped.**
No data migration. Stop the three old containers first (`docker compose down`) —
Docker refuses to remove a volume that is still mounted, and a running backend
would rewrite its SQLite file underneath you. Wiping removes the only rollback
path, so the digest pin (D9) and the `convex export` habit are the whole safety
net.

**D16. The Unraid template is a deliverable, not a footnote.**
An XML template is new to this repo. It carries the GHCR repository string,
bridge networking, host ports 3030/3210/3211, the appdata path, and the env vars
from D4/D8. `docker-compose.yml` stays for local and CI parity.
**Deferred:** the template itself waits on the Unraid appdata path. Image namespace
resolved: `ghcr.io/calmcoconut/ignidash`.
**D11. Introduce one feature-flag module, not scattered `process.env` reads.**
There is no flag infrastructure today (`FEATURE_|ENABLE_|featureFlag` → zero
matches). Add `convex/utils/features.ts` exporting
`billingEnabled | googleEnabled | emailEnabled | aiEnabled`, derived from env
presence, and surface them through the existing boolean-gate queries
(`canUseChat` at `convex/messages.ts:19-25`, `canUseInsights` at
`convex/insights.ts:13-19`, `getHasActiveSubscription` at
`convex/auth.ts:554-562`). The UI then hides rather than silently fails.

**D12. Offline-capable build.**
`.npmrc` has `engine-strict=true` only. Add a registry/mirror line and use
`npm ci --offline` against a seeded cache; pin base images and Convex image by
digest; SHA-pin GitHub Actions (`docker-publish.yml:37-179`, `test.yml:16-19`);
set `NEXT_TELEMETRY_DISABLED=1` in CI (currently Docker-only, `Dockerfile:35,45`);
vendor Playwright browsers or drop e2e from the offline path.

**D13. Guardrail against regressions.**
A CI check that fails on new third-party hosts, plus a runtime verification
(§5) — otherwise the next feature re-introduces egress silently.

---

## 4. Steps

Each step is independently verifiable. Phase A and Phase B are file-disjoint (see
the track table above) and can run in parallel; Phase D runs last.

**Execution tracks.** Work splits into three file-disjoint tracks so they can run
concurrently. The ownership rule is what keeps them from colliding:

| Track                       | Owns                                                                                                       | Must never touch                           |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **T1 — container**          | `Dockerfile`, `docker-compose.yml`, `docker-entrypoint.sh`, `unraid/*.xml`, `SELF_HOSTING.md`, `README.md` | `src/`, `convex/`, `package.json`          |
| **T2 — frontend deletions** | `src/**` — marketing and legal trees, `/` redirect, PostHog, Vercel, link churn                            | `convex/`, `package.json`, any Docker file |
| **T3 — convex deletions**   | `convex/**`, `package.json`, `package-lock.json`                                                           | `src/**`, any Docker file                  |

Two serialization points: **dependency removal (T3) lands before the final image
build (T1)**, and **`convex codegen` runs after T3 and before the final
typecheck**, because T2 compiles against `convex/_generated` types that T3
regenerates.

### Phase A — single container

| #   | Step                                                                                                                                                                            | Verify                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| A0  | **Spike (blocking):** pull the pinned Convex image, inspect `ldd /convex/convex-local-backend`, confirm Node version present, confirm `-i 127.0.0.1` forwarding works           | `ldd` shows no `not found`; `docker run --rm <img> -i 127.0.0.1` binds loopback                      |
| A1  | Rebase `deps`/`builder` stages alpine → `node:22-bookworm-slim`; drop `apk add libc6-compat`                                                                                    | `npm ci` + `npm run build` produce `.next/standalone`; a local `node server.js` serves `/api/health` |
| A2  | New runner stage: `FROM ${CONVEX_IMAGE}` + Node 22 from bookworm-slim + app artifacts (`Dockerfile:41-72` rewritten)                                                            | `docker run --rm <img> node -v` → v22; `./run_backend.sh` still the backend entrypoint               |
| A3  | Supervisor entrypoint: wait-for-`/version`, start backend, start node as nextjs, trap INT/TERM, reap                                                                            | Send `docker stop`; both children exit, no orphans, no 10s timeout kill                              |
| A4  | Extend `/api/health` to probe `/version`; compose healthcheck uses it                                                                                                           | Stop the backend child manually → `/api/health` returns 503                                          |
| A5  | `docker-compose.yml` → one service + volume + 3 ports + merged env; dashboard to `--profile dashboard`                                                                          | `docker compose up -d` shows exactly one running container                                           |
| A6  | `scripts/selfhost.sh`: wait loop (`:140`), admin key exec (`:157`), dashboard branches (`:278,292-293`), add `CONVEX_SITE_URL` + `DISABLE_BEACON` to `CONVEX_VARS` (`:186-200`) | `npm run selfhost -- --init` completes end-to-end on a clean host                                    |
| A7  | CI: `ARG CONVEX_IMAGE`, fix the `--entrypoint node … --version` smoke test (`docker-publish.yml:170`)                                                                           | Workflow builds both arches and the smoke test passes                                                |
| A9  | Unraid template `unraid/ignidash.xml`: GHCR repository, bridge network, host ports 3030/3210/3211, appdata path, env vars                                                       | Template imported on the Unraid box boots the container and serves a working signup over LAN HTTP    |
| A8  | Docs: `SELF_HOSTING.md` (port table `:169-173`, dashboard refs `:57-66,112-116,145-149`), `README.md:97-99`                                                                     | Rendered docs contain no `6791` in the default path                                                  |

### Phase B — vendor egress

| #   | Step                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Verify                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| B1  | Delete PostHog + Vercel Analytics + cookie banner + `/ingest` rewrites; remove `posthog-js`, `posthog-node`, `@vercel/analytics`, `src/lib/posthog-server.ts`, `logo-cloud.tsx`                                                                                                                                                                                                                                                                                                           | `grep -R "posthog\|@vercel/analytics" src convex next.config.ts` → empty                             |
| B2  | **Billing teardown.** Remove `stripe` + `@better-auth/stripe`: plugin registration (`convex/auth.ts:172-183`), `stripeClient` (`:34-38`), `getActiveStripeSubscription` / `getStripeSubscription` (`:523-562`), `src/lib/auth-client.ts:4`. Then delete `src/app/(marketing)/pricing/**`, `src/app/success/**`, `src/app/settings/components/billing-form-*.tsx` and their slots in `settings-forms.tsx`                                                                                  | `grep -Ri "stripe" src convex` → only `convex/betterAuth/schema.ts` (regenerated in B3)              |
| B3  | Regenerate `convex/betterAuth/schema.ts` with `npx @better-auth/cli generate` after the plugin removal; the output drops the `subscription` table and `user.stripeCustomerId`. Never hand-edit — the file is marked auto-generated                                                                                                                                                                                                                                                        | Generated diff has no `stripe*`; `npx convex dev` accepts the schema                                 |
| B4  | Collapse subscription-typed usage limiting: `getSubscriptionInfo` (`convex/utils/ai_utils.ts:114-142`) returns a constant `{ startTime: 0, type: 'admin' }`; keep `checkUsageLimits` / `recordUsage` (`:53-94`), make limits env-configurable and default unlimited                                                                                                                                                                                                                       | Chat + insights work with zero `subscription` rows; messages/insights tests pass                     |
| B5  | **Email teardown.** Remove `@convex-dev/resend`, `convex/convex.config.ts:3,8`, the `resend` client (`convex/auth.ts:25`), `sendResetPassword` (`:57-78`), `changeEmail.sendChangeEmailVerification` (`:105-120`, and set `changeEmail.enabled: false`), the delete-account / verification sends (`:134,417`), and the trial / subscription emails (`:189-382`). Delete `src/app/(auth)/forgot-password/**` and `src/app/(auth)/reset-password/**` plus their links in `sign-in-form.tsx` | `grep -R "resend\|sendEmail" convex src` → empty; no `/forgot-password` route resolves               |
| B6  | Document operator-assisted recovery (the only remaining path to a forgotten password) in `SELF_HOSTING.md`                                                                                                                                                                                                                                                                                                                                                                                | Procedure written and exercised once against a throwaway account                                     |
| B7  | Gate the Google button on the same env expression as `convex/auth.ts:84-88`; replace avatars with initials (`sidebar-auth.tsx:30`, `mobile-header.tsx:54`, `ai-chat-drawer.tsx:176`); drop `lh3.googleusercontent.com`, `images.unsplash.com`, `tailwindcss.com` from `remotePatterns`                                                                                                                                                                                                    | Unset `GOOGLE_*` → no button, no `lh3` requests                                                      |
| B8  | AI provider-agnostic: `OPENAI_BASE_URL` + model names from env (`convex/use_openai.ts:14-30,58,140`); hide chat/insights entry points when `aiEnabled` is false                                                                                                                                                                                                                                                                                                                           | Pointed at a local server → chat works; unset → features hidden, nothing crashes                     |
| B9  | Kill-switches: `DISABLE_BEACON=true`, better-auth telemetry off, and convert the four self-HTTP calls in `convex/auth.ts:156,447,458,474` to direct internal function calls (removes the `CONVEX_SITE_URL` dependency)                                                                                                                                                                                                                                                                    | No beacon in backend logs; `CONVEX_SITE_URL` unset → default plan still created on signup            |
| B10 | Delete the `(marketing)` tree (`page.tsx`, `about/`, `pricing/`, and `components/*`); add a `/` → `/signup` redirect; trim `sitemap.ts` / `robots.ts`                                                                                                                                                                                                                                                                                                                                     | `/` lands on signup; `/about` and `/pricing` do not resolve; `npm run build` has no unresolved route |
| B11 | Delete the `(legal)` tree and strip the six reference blocks listed in §6 item 6                                                                                                                                                                                                                                                                                                                                                                                                          | `grep -rn "/privacy\|/terms" src` → empty                                                            |
| B12 | Delete `e2e/stripe.spec.ts`; remove Google and forgot-password assertions from `e2e/auth.spec.ts`                                                                                                                                                                                                                                                                                                                                                                                         | `npm run test:e2e` passes with no reference to removed routes                                        |

### Phase D — guardrails

| #   | Step                                                                      | Verify                                       |
| --- | ------------------------------------------------------------------------- | -------------------------------------------- |
| D1  | CI grep gate for third-party hosts in `src/`, `convex/`, `next.config.ts` | Introducing a PostHog import fails the build |
| D2  | End-to-end egress audit script                                            | See §5                                       |

---

## 5. Acceptance criteria

1. `docker compose up -d` starts **one** container; `docker compose ps` shows one row.
2. A full journey works inside it: signup → create plan → edit inputs → run single simulation → run Monte Carlo → view results → export → settings. No 3-container dependency, no dashboard required.
3. `tcpdump` on the container's veth during that journey shows **no** connections to non-RFC1918 / non-loopback addresses (Convex loopback + the browser's own sessions only).
4. `grep -RE "posthog|stripe\.com|api\.resend\.com|googleapis|googleusercontent" .next/` → empty. The `openai` SDK remains by design; it must have no endpoint configured.
5. Signup works with **only** `BETTER_AUTH_SECRET`, `CONVEX_API_SECRET`, `SITE_URL`, `NEXT_PUBLIC_CONVEX_URL`, `NEXT_PUBLIC_CONVEX_SITE_URL` set.
6. No route or code path attempts to send email: `/forgot-password` and `/reset-password` are gone, and a forgotten password is recoverable only through the documented operator procedure.
7. `/` redirects to `/signup`; no `/pricing`, `/privacy`, `/terms` or `/about` route resolves.
8. The Unraid template boots the image with host ports 3030/3210/3211 and reaches a working signup on a LAN IP over plain HTTP.

---

## 6. Open Questions

**Resolved (2026-10-29):**

1. Goal-2 scope → **runtime egress only**. Phase C (offline builds) deferred; §7.
2. AI → **keep, provider-agnostic** (`OPENAI_BASE_URL`, hidden when unconfigured). Step B8.
3. Payments → **delete the billing surface**. Steps B2–B4, plus D14.
4. Password reset → **drop recovery**, operator-assisted only. Steps B5–B6.

**Resolved — round 2 (2026-10-29):**

5. Root route → `/` **redirects to `/signup`** (T2).
6. Legal pages → **deleted**; the six link blocks in `sign-in-form.tsx:163,167`, `sign-up-form.tsx:113,117`, `account-dropdown-menu.tsx:39,43,69,73`, `ai-chat-drawer.tsx:429` and `generate-dialog.tsx:114` are stripped with them.
7. Volume → **wipe the existing `convex-data` in place** (D15).
8. Image namespace → **your own GHCR namespace**; the exact string is still needed.
9. Parallelism → **three disjoint tracks** T1/T2/T3, rule in §4.

**Resolved values:** GHCR namespace `ghcr.io/calmcoconut/ignidash`; Convex digest `sha256:207cf95def42f01614b6e3af0af5c20d0dcaa5ff2adf258ee7bc9555576644fa`. **Deferred:** the Unraid appdata path — A9 (template) is on hold, everything else proceeds. AI `OPENAI_BASE_URL` and model names stay deferred; the feature hides until they exist.

---

## 7. Out of scope

- Replacing Convex with SQLite/IndexedDB, or Next.js with anything else — a rewrite, not a refactor.
- The cloud/Vercel path (`.env.cloud.example`, Stripe webhooks in production, hosted pricing). Changes are gated so it keeps working.
- A single-port deployment (Convex proxied through Next) — needs a sidecar proxy for WebSocket upgrades.
- **PUID/PGID remapping.** The template uses the image's fixed uids — root for the backend, 1001 for the app.
- Preserving analytics history, or migrating PostHog/Stripe data anywhere.
- **Offline / reproducible builds** (Phase C: npm mirror, digest pinning, SHA-pinned Actions, vendored Playwright). Deferred by your scope choice; revisit only if you need to build with no registry access.
- **Local fonts.** Build-time Google fetch with no runtime egress — deferred alongside Phase C.
- A `npx convex run` admin helper for password resets. Possible follow-up, not in this plan.

---

## 8. Risks

| Risk                                                                                                                                      | Mitigation                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| ~~`createCustomerOnSignUp` with a stub Stripe client aborts signup~~                                                                      | **Eliminated** by B2 — the plugin and its sign-up hook are removed. Test signup first anyway; B2 is the earliest de-risk.              |
| Backend needs glibc 2.39 → the final base is a large ubuntu image (~1 GB+)                                                                | Accepted; alternative is a static rebuild of the Rust backend (out of scope)                                                           |
| Backend memory: `convex-local-backend` + a never-recycled `node local.cjs` executor, 500 MB–1.5 GB under load                             | Set a container memory cap; document periodic restart; watch `SELF_HOSTING.md:175`'s existing memory warning                           |
| Backend restart now restarts the app too (shared container)                                                                               | Supervisor restarts the child, not the container; healthcheck surfaces it                                                              |
| `npm run build` may need Convex reachable (pricing page preloads an auth query, no `force-dynamic` anywhere)                              | Verify with an offline build **before** C1; if it fails, mark the route dynamic                                                        |
| `.env.selfhost.example` is unreadable to this tooling (policy `*:*/*.env.*`)                                                              | Env template edits must be made by you or with permission; the plan lists required changes by variable name only                       |
| Admin key regenerates on every `npm run selfhost` run (`SELF_HOSTING.md:71`) — any auto-deploy design would invalidate stored credentials | Keep host-side deploy; do not automate key regeneration                                                                                |
| **No password recovery.** A forgotten password is a permanent lockout without operator intervention                                       | Document the procedure (B6); keep the `verification` and `session` tables intact so a reset flow can be added back later               |
| Billing teardown reaches into AI usage limiting (`convex/utils/ai_utils.ts:53-94`)                                                        | B4 collapses only the _type_, keeping the accounting; run the messages/insights tests before and after                                 |
| Regenerating `convex/betterAuth/schema.ts` drops `subscription` + `user.stripeCustomerId`                                                 | Auto-generated file — regenerate, never hand-edit. Rows become orphaned; `npx convex export` first if the deployment has real users    |
| Wiping the volume removes the only rollback path (D15)                                                                                    | Digest pin + `npx convex export` before every upgrade; the three-container compose stays in git history as a reference                 |
| Deleting the marketing and legal trees orphans link blocks outside them                                                                   | The exact lines are enumerated in §6 item 6; strip them in the same change as the deletion, or the build fails on unresolved routes    |
| T2 and T3 churn `convex/_generated` types mid-flight                                                                                      | Run `convex codegen` after T3 and before the final typecheck; transient type errors in intermediate commits are expected               |
| Removing AI accounting changes internal scheduler payloads                                                                                | Typecheck `messages.ts`, `insights.ts` and `use_openai.ts` together — they share the `subscriptionStartTime` / `subscriptionType` args |

---

## 9. Evidence index

Reconnaissance reports behind every claim above:

- Deployment topology: `Dockerfile`, `docker-compose.yml`, `docker-entrypoint.sh`, `scripts/selfhost.sh:130-300`, `.github/workflows/docker-publish.yml:30-120`
- Runtime egress: 66-row inventory (path:line) across `src/`, `convex/`, `next.config.ts`
- Feature coupling: `convex/auth.ts`, `convex/use_openai.ts`, `convex/utils/ai_utils.ts:114-121`, ~40 PostHog call sites
- Build surface: `package.json`, `package-lock.json` (13,706 lines, ≥2,000 resolved tarballs, all `registry.npmjs.org`)
- Upstream Convex facts: `get-convex/convex-backend` — `Dockerfile.backend`, `run_backend.sh`, `read_credentials.sh`, `beacon.rs`, `self-hosted/docker/docker-compose.yml`, `test_self_hosted_backend.yml`

---

## 10. Implementation status (2026-10-29)

**Landed and verified locally.**

| Check                                          | Result                                                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `npx tsc --noEmit`                             | 0 errors                                                                                                                 |
| `npx eslint .`                                 | clean                                                                                                                    |
| `npx vitest run`                               | 44 files · 1244 tests passing                                                                                            |
| `next build` (`SELF_HOSTED=true`)              | succeeds **with no Convex backend running** — every route resolved dynamic, which kills the §8 "build needs Convex" risk |
| `docker compose config`                        | validates                                                                                                                |
| `.next/` vendor scan                           | zero hits for `posthog`, `stripe.com`, `api.resend.com`, `googleusercontent`, `fonts.googleapis`                         |
| `docker-entrypoint.sh` / `scripts/selfhost.sh` | `bash -n` clean                                                                                                          |

| Track            | State                                                                                                                                                                                                                             |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T1 container** | `Dockerfile` (glibc-matched build stages, Convex-image runner, tini, digest-pinned), supervisor `docker-entrypoint.sh`, single-service `docker-compose.yml`, CI smoke test, `scripts/selfhost.sh`, `SELF_HOSTING.md`, `README.md` |
| **T2 frontend**  | marketing + legal + success + pricing trees deleted; `/` → `/signup`; PostHog and Vercel Analytics removed (~50 sites); Google gated with initials avatars; billing UI gone; password routes gone; email-verified badge gone      |
| **T3 backend**   | Stripe/Resend/PostHog removed from `convex/`; `subscription` table and `stripeCustomerId` dropped; usage accounting deleted; AI provider OpenAI-compatible; 29 packages pruned                                                    |

### Known gaps

- **Generated files were hand-edited.** `convex/_generated/*` and `convex/betterAuth/schema.ts` could not be regenerated: the better-auth CLI cannot import a factory-shaped `createAuthOptions`, and `convex codegen` requires a reachable deployment. `tsc` validates the result, but run `npx convex codegen` against the live deployment before trusting it.
- **A0 is unverified.** No Docker daemon was available, so `ldd /convex/convex-local-backend` and the `-i 127.0.0.1` bind flag were never exercised. The first `docker compose build` is the real test of the glibc assumption — if it fails, the runner base is wrong and nothing else matters.
- **`.env.selfhost.example` untouched.** The tooling policy denies any `*:*/*.env.*` path, so it still lists `STRIPE_*`, `RESEND_API_KEY`, `NEXT_PUBLIC_POSTHOG_*` and `CONVEX_API_SECRET`, and lacks the new `OPENAI_*` / `NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED` entries.
- **Unraid template deferred** (D16) — needs the appdata host path.
- **`@convex-dev/rate-limiter`** is still installed and registered in `convex.config.ts` although nothing uses it.
- **e2e not executed** — Playwright browsers are not vendored and the suite needs a live deployment.
