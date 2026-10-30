# Grill Me Results

Generated: 2026-10-30T03:05:35.835Z

## Plan

to ask me questions on the plan

## Shared Understanding

Single-container, zero-runtime-egress self-host for Unraid. Private fork with aggressive deletion (no upstream mergeability burden). One image = digest-pinned Convex backend + Next.js standalone under tini, publishing host ports 3030/3210/3211 on LAN plain HTTP. Deleted outright: Stripe billing + the auto-generated subscription schema, the entire email subsystem (Resend, reset, verification, email change, delete-account confirmation), PostHog, Vercel Analytics, the marketing tree, and the legal tree. Kept and made provider-agnostic: AI (openai-compatible base URL, auto-enabled, usage accounting removed). Frozen deployment: no data migration, existing Convex volume wiped. Deliverables: GitHub Actions image on the user's GHCR namespace, an Unraid template XML, and a three-track parallel execution split.

## Questions and Answers

### 1. Is this a private fork where aggressive deletion is fine, or must the code stay mergeable with upstream?

**Recommended answer:** Private fork, delete outright

**User answer:** Private fork — delete outright

**Status:** resolved

**Notes:** No upstream compatibility burden; deletions are real deletions, no gating scaffolding.

### 2. What order do you want the work delivered in?

**Recommended answer:** B2 billing spike → Phase A → rest of Phase B

**User answer:** parallelize where possible with subagents

**Status:** resolved

**Notes:** Custom answer. Parallel execution preferred over strict phasing; requires a concrete disjoint-file split so concurrent tracks cannot collide on convex/ or package.json.

### 3. Your Unraid host already has a Convex volume with users and plans. How should the cutover go?

**Recommended answer:** Fresh start, no migration

**User answer:** Fresh start — new deployment, no migration

**Status:** resolved

**Notes:** Empty volume; avoids schema-removal failures on documents holding removed fields.

### 4. Where should the merged image be built?

**Recommended answer:** GitHub Actions on your fork

**User answer:** GitHub Actions on your fork

**Status:** resolved

**Notes:** Unraid host stays out of the build; compose/template pulls a tag from GHCR.

### 5. How do you actually want to run it on Unraid?

**Recommended answer:** Compose as source of truth with template fields documented

**User answer:** Unraid Docker UI template

**Status:** resolved

**Notes:** Adds a new artifact not in the repo today: an Unraid template XML. Compose still needed for local/dev parity.

### 6. How is Ignidash reached today, and how should the merged container advertise itself?

**Recommended answer:** LAN only over plain HTTP

**User answer:** LAN only, plain HTTP via IP

**Status:** resolved

**Notes:** CONVEX_CLOUD_ORIGIN=http://10.0.0.5:3210, CONVEX_SITE_ORIGIN=http://10.0.0.5:3211, SITE_URL=http://10.0.0.5:3030. No TLS or proxy.

### 7. Your current container maps 10.0.0.5:3030 to 3000. Keep that?

**Recommended answer:** Keep host port 3030

**User answer:** Keep host port 3030

**Status:** resolved

**Notes:** Matches the existing Unraid port mapping; docs and template must use 3030, not 3000.

### 8. Should the single container publish three ports or one?

**Recommended answer:** Publish 3000, 3210, 3211

**User answer:** Publish 3000, 3210, 3211

**Status:** resolved

**Notes:** Host side 3030/3210/3211. No sidecar proxy, no WebSocket edge cases.

### 9. What happens to the Convex dashboard?

**Recommended answer:** Optional compose profile, off by default

**User answer:** Drop entirely, document CLI equivalents

**Status:** resolved

**Notes:** SELF_HOSTING.md:145-149 (betterAuth_jwks repair via dashboard) must be rewritten as a CLI procedure.

### 10. The public marketing tree is the hosted product's front door. What happens to it?

**Recommended answer:** Remove /pricing and repoint its links to /signup

**User answer:** Delete the whole marketing tree

**Status:** resolved

**Notes:** Removes /, /about, /pricing, /faq content and legal pages. Leaves landing target undefined and orphans Upgrade CTAs outside the marketing tree (sidebar nav, account menu, AI upsell).

### 11. With email gone, how should account deletion work?

**Recommended answer:** Immediate delete with typed confirmation

**User answer:** Immediate delete with typed confirmation

**Status:** resolved

**Notes:** Replaces sendDeleteAccountVerification (convex/auth.ts:129).

### 12. Nothing verifies email once Resend is gone. What should the settings badge show?

**Recommended answer:** Hide the badge

**User answer:** Hide the badge

**Status:** resolved

**Notes:** Removes isEmailVerified from ProfileInfoForm (settings-forms.tsx:60).

### 13. What should the provider-agnostic AI point at in practice?

**Recommended answer:** Generic OpenAI-compatible, auto-enabled when a base URL is set

**User answer:** Generic OpenAI-compatible, auto-enable

**Status:** resolved

**Notes:** OPENAI_BASE_URL present → enabled; absent → UI hidden.

### 14. After billing is gone, what should the AI usage accounting do?

**Recommended answer:** Unlimited by default with an optional env cap

**User answer:** Remove accounting entirely

**Status:** resolved

**Notes:** Contradicts plan D14. Removes checkUsageLimits/recordUsage/getSubscriptionInfo and the pricing constants; changes internal scheduler payloads in messages.ts and insights.ts.

### 15. stripe.spec.ts tests a checkout flow that will no longer exist. What happens to e2e?

**Recommended answer:** Delete the obsolete specs and assertions

**User answer:** Delete obsolete specs and assertions

**Status:** resolved

**Notes:** stripe.spec.ts removed; Google and forgot-password assertions removed from auth specs.

### 16. The backend runs in-place migrations at startup, so a downgrade can corrupt state. How should it be pinned?

**Recommended answer:** Digest pin with a documented bump step

**User answer:** Digest pin + documented bump

**Status:** resolved

**Notes:** Compensates for dropping the dashboard: no snapshot/rollback safety net.

## Agreed Decisions

- Private fork — delete outright; no env/build gating for upstream compatibility.
- Parallelize with subagents across three file-disjoint tracks: T1 container (Dockerfile/compose/entrypoint/Unraid template/docs), T2 frontend deletions (src/), T3 convex deletions (convex/ + package.json). Rule: only T3 touches convex/ or package.json; T2 never touches Docker files.
- Fresh start — new Convex deployment, no data migration; the existing convex-data volume is wiped in place after stopping the three old containers.
- Image built by GitHub Actions on the user's fork, published under the user's own GHCR namespace.
- Deployed on Unraid via a Docker UI template (new XML artifact in the repo); docker-compose remains for local/CI parity.
- LAN only, plain HTTP via IP: CONVEX_CLOUD_ORIGIN=http://10.0.0.5:3210, CONVEX_SITE_ORIGIN=http://10.0.0.5:3211, SITE_URL=http://10.0.0.5:3030.
- Host port 3030 kept for the app (matches the existing Unraid mapping); 3210 and 3211 also published, no sidecar proxy.
- Convex dashboard dropped entirely; dashboard-only tasks become documented CLI procedures (npx convex logs|data|env|run|export).
- Delete the whole marketing tree, including /pricing, /about and the root marketing page; / loses its route and must be replaced with a redirect to /signup.
- Delete the (legal) tree too (/privacy, /terms) and strip the six link blocks outside it in sign-in-form, sign-up-form, account-dropdown-menu, ai-chat-drawer and generate-dialog.
- Account deletion becomes immediate with a typed confirmation, replacing sendDeleteAccountVerification.
- Hide the email-verified badge in ProfileInfoForm rather than marking accounts verified.
- AI kept generic: OpenAI-compatible via OPENAI_BASE_URL with model names from env, auto-enabled when the base URL is set, hidden otherwise.
- AI usage accounting removed entirely — delete recordUsage, checkUsageLimits, getSubscriptionInfo and calculateTokenCost; keep getCanUseAIFeatures and redefine it as 'AI configured?'.
- Delete e2e/stripe.spec.ts and remove Google / forgot-password assertions from the auth specs.
- Pin the Convex backend image by digest with a documented bump step.

## Open Risks

- Wiping the volume in place removes the only rollback path; Docker refuses to remove a volume still mounted, so the three old containers must be shut down first, and the backend must not be running when the data is deleted.
- No password recovery at all: a forgotten password is a permanent lockout without operator intervention. The documented procedure must be written and actually tested once.
- The exact GHCR namespace string is still unknown, so the Unraid template cannot be finalized (repository field).
- The Unraid appdata path for the new volume is still unknown (template host-path field).
- The Convex image digest is not yet resolved — must be obtained by pulling the image during the A0 spike; upstream publishes under ghcr.io/convex/, while the repo's compose references ghcr.io/get-convex/ and the alias is unverified.
- Deleting the marketing and legal trees orphans link blocks outside them (sign-in form, sign-up form, account dropdown, AI chat drawer, insights generate dialog, navbar, cookie banner); unresolved Next.js routes fail the build.
- T2 and T3 churn convex/\_generated types concurrently; convex codegen must run after T3 and before the final typecheck, so intermediate commits may show transient type errors.
- Removing AI usage accounting changes internal scheduler payloads shared by messages.ts, insights.ts and use_openai.ts; they must be typechecked together.
- The Convex backend handles SIGINT only (no SIGTERM handler); the supervisor must send SIGINT and reap the backend's node executor child, or shutdown truncates in-flight work.
- Billing teardown requires regenerating the auto-generated convex/betterAuth/schema.ts rather than hand-editing it; the removed subscription table and user.stripeCustomerId disappear from the schema as a side effect.

## Next Decision Needed

No decisions remain open. Three values are still needed to finish the plan's remaining unknowns: (1) the GHCR namespace — ghcr.io/<user-or-org>/ignidash — for the Unraid template's repository field; (2) the Unraid appdata host path for the new Convex volume; (3) the Convex image digest, obtainable during the A0 spike. The AI OPENAI_BASE_URL and model names are intentionally deferred — the feature stays hidden until they exist.
