# Architecture: Weekly Authority Newsletter (E-02)

## 1. System Overview

Three planes. Postgres is system of record. n8n is workers. GHL LC Email v3 is the ESP. Twenty is a projection. The control-plane HTTP API owns locks, tokens, freeze, kill, audit, archive, and outbox.

## 2. Data Flow

```txt
Clock / operator
→ POST /issues/collect (advisory lock)
→ ingest posts + threats (SSRF allowlist, sanitize)
→ ContentItem rows
→ select/score (caps)
→ LLM JSON or deterministic summarizer (untrusted data region)
→ MJML + plaintext
→ QA gates
→ artifacts SHA256
→ pending_approval + staff email (inert GET)
→ POST approve (CSRF, optional dual-control)
→ freeze revision
→ outbox {issueKey}:{revision}:schedule
→ GHL create+schedule (sandbox/DRY_RUN rules)
→ reconcile + stats
→ Twenty upsert (optional)
```

## 3. Module Breakdown

### Control plane API (`src/`)

* Responsibility: HTTP, pages, lifecycle
* Inputs: workers, approvers
* Outputs: issue JSON, HTML pages, outbox
* Files: `src/index.ts` (same `start` as `src/server.ts`), `src/app.ts`, `src/routes/health.ts`, `src/routes/approval.ts`, `src/routes/internal.ts`, `src/services/control.ts`, `src/store/memory.ts`, `src/store/postgres.ts`, `src/db/migrate.ts`

### Domain (`src/domain`)

* Responsibility: issueKey, hash/CSRF, keyed mutex, dual-control / kill policy,
  lifecycle state machine (`lifecycle.ts`)
* No I/O except pure functions
* `lifecycle.ts` decides which status transitions reconcile may write. Reconcile
  observes GHL; it must never become a second path to sending, so no state that
  has not already been approved and drained can reach a sending status through
  it, and `sent` is terminal.

### Ingest (`src/ingest`)

* RSS/Atom and CISA KEV → ContentItem (`kind`, `schemaVersion: 1.0.0`)

### Assemble (`src/assemble`)

* Select, summarize, MJML, QA, freeze artifacts — `src/assemble/pipeline.ts`, `src/qa/gates.ts`, `src/select/score.ts`

### GHL adapter (`src/ghl/client.ts`)

* `GhlClient` v3 create/schedule/get; rejects rss + outbound; env-gated audience; sandbox spike refuses `APP_ENV=production`
* Live HTTP is implemented: bearer PIT, `Version` header from `GHL_API_VERSION`,
  20s timeout, retries only 429/5xx (a 4xx is our payload being wrong and will
  fail identically), and every request/response pair captured to
  `artifacts/spike/` with the bearer redacted.
* Every guard runs *before* the request leaves, and DRY_RUN or a missing PIT
  short-circuits earlier still, so a refusal never reaches the network.
* **The binding log is a runtime gate.** `src/ghl/binding.ts` counts
  `UNVERIFIED` rows in `docs/BINDING-DECISIONS.md`; while any remain, the
  production audience is refused regardless of environment. Missing file =
  unverified. This makes Gate B mechanical rather than a checklist line.

### Paths (`src/paths.ts`)

* One place that resolves the app root, so prompts, templates and migrations
  are found identically from `src/` in development and from `dist/` in the
  built image. Four modules previously derived this from their own file depth,
  which only worked while everything ran from `src/`.

### n8n (`n8n/`)

* One job per workflow; HTTP to control plane; dummy payloads

### Artifacts

* `artifacts/issues/{encodedKey}/r{revision}/`

## 4. Tech Stack Decision

| Layer | Choice | Reason |
| ----- | ------ | ------ |
| API | Fastify + TypeScript | Strict, small, Windows-friendly |
| SoR | Postgres 16 | Locks, unique issueKey, outbox |
| Workers | n8n JSON + in-process assemble script | Ticket stack; dummy E2E without n8n |
| Templates | MJML | Predictable email HTML |
| ESP | GHL LC Email v3 | List + RFC 8058 on LC Email |
| CRM | Twenty stub | Projection only |
| Tests | Vitest | Security gates without live GHL |

## 5. Failure Handling

* API/GHL fail: transient errors retry with exponential backoff (4 attempts,
  60s doubling to a 1h cap) while the row stays `pending`; refusals that would
  recur identically — empty recipients, placeholder brand config, missing frozen
  artifact, any `GhlBanError` — dead-letter on the first attempt so the watchdog
  escalates immediately rather than 15 minutes later
* Dead letter: outbox `failed` + issue `failed` + `outbox_dead_letter` event;
  recovery is re-assemble and re-approve, never a hand-edited outbox row
* Reconcile: per-issue errors are recorded and the batch continues
* Watchdog: escalates overdue approvals and dead letters by notification only —
  it has no write path toward a sending state
* Model bad JSON: retry once, qa_failed
* Invalid/malicious ingest: drop item or fail QA
* Network slow: fetch timeouts
* Database fail: collect/assemble 503
* Kill L1/L2: no clock / no outbox
* Missing GHL creds: DRY_RUN success, spike script exits with instructions

## 6. Deployment shape

* **Build.** `scripts/build.mjs` bundles `src/` to `dist/` with esbuild;
  `node_modules` stay external. Bundling rather than a `tsc` emit because the
  source uses extensionless relative imports and Node's ESM loader requires
  explicit `.js` extensions — bundling resolves them at build time instead of
  rewriting every import in the repo.
* **Image.** Two stages. The build stage typechecks and compiles; the runtime
  stage carries production dependencies, `dist/`, and the runtime assets only —
  no TypeScript, no `tsx`, no toolchain. Runs as the base image's unprivileged
  `node` user, base pinned by digest.
* **`dist/` sits at `src/`'s depth** so `src/paths.ts` resolves the app root the
  same way in both, and the asset layout matches the dev tree.
* **Healthcheck** reads the `ok` field of `/health`, not just HTTP 200, so a
  reachable API with a dead database fails it.
* **Migrations** run as a separate one-shot service (`node dist/migrate.js`)
  that must complete before the API starts.
* **Backups** are cron-driven (`deploy/backup.crontab`): daily `pg_dump` +
  frozen artifacts with checksums, weekly restore drill into a scratch database.
