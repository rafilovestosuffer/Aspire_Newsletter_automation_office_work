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

## Block 7: Lifecycle through `sent`

**Goal:** Close the loop from `scheduled` to a terminal state, and make the three
stub workers real.

**Files changed:** `src/domain/lifecycle.ts`, `src/services/control.ts`,
`src/routes/internal.ts`, `src/store/*`, `src/ghl/client.ts`,
`migrations/003_lifecycle.sql`, `tests/reconcile.test.ts`, `tests/watchdog.test.ts`

**Acceptance criteria:**

* [x] `reconcile` maps GHL campaign status onto `IssueStatus` and is the only
      path that writes `sent`
* [x] A state machine forbids reaching a sending status from anything not
      already approved and drained; `sent` is terminal
* [x] `watchdog` escalates overdue approvals and dead letters, and has no write
      path toward sending
* [x] Outbox retries transient failures with backoff; refusals dead-letter at once
* [x] `countProductionSent()` counts only real production sends, so sandbox and
      DRY_RUN cannot graduate dual control
* [ ] `observe` — deferred: GHL statistics field names are UNVERIFIED until the
      sandbox spike
* [ ] Kill L3 pause/cancel — deferred: no documented v3 body; UI only

**Test:** `npm test` (179 with Postgres)

**Rollback:** `KILL_SWITCH=1`; migration 003 is additive.

**Risk:** A GHL response driving an unapproved issue toward `sent` — blocked by
the state machine, asserted directly in `tests/reconcile.test.ts`.

## Block 8: Production image, backups, runbook, docs

**Goal:** Make the deployment production-shaped and the operational docs true.

**Files changed:** `Dockerfile`, `scripts/build.mjs`, `src/paths.ts`,
`scripts/backup.sh`, `scripts/restore-drill.sh`, `deploy/backup.crontab`,
`docker-compose.prod.yml`, `docs/RUNBOOK.md`, `README.md`, `ARCHITECTURE.md`

**Acceptance criteria:**

* [x] Image compiles TypeScript at build time; no `tsx` in the runtime stage
* [x] Runs as a non-root user, base image pinned by digest
* [x] `HEALTHCHECK` reads the `ok` field, so a dead database fails it
* [x] Backup is atomic, checksummed, verified, pruned, and can copy off-box
* [x] Restore drill restores into a scratch database and checks schema, the
      append-only trigger, row counts and artifacts — **executed, passing**
* [x] Backups and the weekly drill are scheduled (`deploy/backup.crontab`)
* [x] Runbook has an on-call table, lifecycle/worker operations, and a Gate B
      checklist
* [x] README/ARCHITECTURE reconciled to the code

**Test:** `npm test`, `npm run build`, prod-only install boots `dist/`,
`./scripts/backup.sh` then `./scripts/restore-drill.sh`

**Rollback:** previous image tag; migration 003 is additive.

**Risk:** Image not built in CI against a real Docker daemon — see the note in
Block 8's verification below.

## Block 9: Approver email + live GHL client

**Goal:** Close the last two unblocked gaps — real approver notification, and a
live HTTP transport so the sandbox spike can actually be run.

**Files changed:** `src/services/notify.ts`, `src/ghl/client.ts`,
`src/ghl/binding.ts`, `scripts/ghl-spike.ts`, `src/env.ts`, `Dockerfile`,
`tests/notify.test.ts`, `tests/ghl-live.test.ts`, `tests/invariants.test.ts`

**Acceptance criteria:**

* [x] Approvers notified by transactional email (SMTP, vendor-neutral, **not**
      LC Email — that is the list channel)
* [x] Notification failures never break approval, but always write
      `notify_sent` / `notify_failed` to `issue_events`
* [x] Live GHL HTTP implemented: timeouts, 429/5xx-only retries, trace ids
* [x] Every guard runs before the request leaves; DRY_RUN and a missing PIT
      short-circuit before any network I/O
* [x] Request/response captured to `artifacts/spike/`, bearer token redacted
* [x] Binding log enforced at runtime: production audience refused while any
      `UNVERIFIED` row remains; missing file fails closed
* [x] Spike runner performs a real create → read-back → optional seed send, and
      refuses production and DRY_RUN
* [ ] **Spike executed** — blocked on a GHL sandbox sub-account
* [ ] Binding log rows filled from captures — follows the spike
* [ ] Winning send path recorded — follows the spike

**Test:** `npm test` (216 with Postgres); spike verified end to end against a
local fake GHL server, and three guard mutations confirmed red.

**Rollback:** `KILL_SWITCH=1`. The binding-log gate keeps production refused
regardless.

**Risk:** A row marked verified without a real capture would open the gate —
which is why the captures are committed as evidence.
