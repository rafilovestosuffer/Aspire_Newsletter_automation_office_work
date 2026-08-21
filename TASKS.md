# TASKS: Weekly Authority Newsletter (E-02)

Blocks below describe the factory. This implementation lands Blocks 1–6 in-repo. Block 3 live spike still requires sandbox credentials.

## Block 1: Docs, contracts, env matrix

**Goal:** Product docs and schemas exist so agents do not invent ESP payloads.

**Files likely changed:**

* `PRD.md`, `ARCHITECTURE.md`, `TASKS.md`, `CLAUDE.md`, `AGENTS.md`, `README.md`
* `docs/*`, `contracts/*`, `config/*.yaml.example`, `.env.example`

**Steps:**

1. Write assumptions and non-goals.
2. JSON Schema for ContentItem, Issue, feeds, brand.
3. Binding log with VERIFIED-DOCS vs UNVERIFIED.

**Acceptance criteria:**

* [x] ARCHITECTURE.md present
* [x] BINDING-DECISIONS.md does not mark filter child fields VERIFIED
* [x] Config examples use TODO for unknown client facts

**Test:** `npm run typecheck`

**Rollback:** delete docs only if replacing with this set.

**Risk:** Docs drift from code — cross-check in Block 6.

## Block 2: Control plane

**Goal:** Postgres + Fastify with inert GET approval and advisory locks.

**Files likely changed:** `migrations/001_init.sql`, `src/store/*`, `src/db/migrate.ts`, `src/routes/approval.ts`, `src/services/control.ts`

**Steps:**

1. Migrate issues, tokens, events, outbox, kill_state.
2. GET approve page does not consume.
3. POST consumes once with CSRF.

**Acceptance criteria:**

* [x] Unit tests for GET no-op and single consume
* [x] Token stored hashed

**Test:** `npm test`

**Rollback:** drop tables via compose down -v.

**Risk:** Safe Links — never add GET side effects.

## Block 3: GHL v3 client + spike script

**Goal:** Typed client for documented v3 routes; spike script for sandbox; no prod send.

**Files likely changed:** `src/ghl/*`, `scripts/ghl-spike.ts`, `docs/BINDING-DECISIONS.md`

**Steps:**

1. Create/schedule types from marketplace docs.
2. Reject rss and conversations outbound.
3. Spike script uses sandbox location + seed audience only.

**Acceptance criteria:**

* [x] Forbidden scheduleType rss throws
* [x] Prod filter blocked when DRY_RUN or APP_ENV!=production
* [ ] Live sandbox proof (needs PIT) — script ready

**Test:** `npm test -- tests/ghl.test.ts`

**Rollback:** keep DRY_RUN true.

**Risk:** emailMeta/filter child fields UNVERIFIED.

## Block 4: Ingest security

**Goal:** Allowlisted fetch, sanitize, ContentItem v1, fixtures including malicious RSS.

**Files likely changed:** `src/ingest/*`, `fixtures/*`

**Steps:**

1. RSS + KEV parsers.
2. SSRF: allowlist hosts, no off-list redirects.
3. Malicious fixture.

**Acceptance criteria:**

* [x] Script title stripped
* [x] Redirect off allowlist blocked

**Test:** `npm test -- tests/ssrf.test.ts tests/sanitize.test.ts`

**Rollback:** disable live feeds (enabled: false).

**Risk:** CMS URL TODO — fixtures until S-02 RSS exists.

## Block 5: Assemble + QA

**Goal:** Score/select, JSON summaries with citation allow-list, MJML+plaintext, QA pack.

**Files likely changed:** `src/select/score.ts`, `src/qa/gates.ts`, `src/assemble/pipeline.ts`, `templates/*`, `prompts/*`

**Steps:**

1. Caps 5 posts / 7 threats.
2. LLM or deterministic fallback.
3. Href allow-list and CVE check.

**Acceptance criteria:**

* [x] Extra href fails QA
* [x] CVE not in source fails QA
* [x] `assemble:fixture` writes artifacts

**Test:** `npm test` && `npm run assemble:fixture`

**Rollback:** use previous frozen revision.

**Risk:** Meaning-drift — human POST still required.

## Block 6: Governance + delivery wiring

**Goal:** Dual-env, DRY_RUN, dual-control, freeze, outbox, reconcile, watchdog, Twenty stub, runbook tabletop.

**Files likely changed:** `src/services/control.ts`, `src/twenty/client.ts`, `n8n/*`, `docs/RUNBOOK.md`

**Steps:**

1. Outbox idempotency key.
2. Dual-control first N.
3. n8n JSON dummy payloads.
4. Runbook tabletop.

**Acceptance criteria:**

* [x] Outbox will not schedule prod in DRY_RUN
* [x] n8n workflows exist without workflow 06
* [x] Runbook documents resume-after-time

**Test:** `npm test -- tests/lock.test.ts tests/ghl.test.ts tests/approval.test.ts`

**Rollback:** KILL_SWITCH=1.

**Risk:** Duplicate n8n cron — Postgres is mutex.
