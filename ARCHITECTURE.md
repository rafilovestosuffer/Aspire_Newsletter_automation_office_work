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

* Responsibility: issueKey, hash/CSRF, keyed mutex, dual-control / kill policy
* No I/O except pure functions

### Ingest (`src/ingest`)

* RSS/Atom and CISA KEV → ContentItem (`kind`, `schemaVersion: 1.0.0`)

### Assemble (`src/assemble`)

* Select, summarize, MJML, QA, freeze artifacts — `src/assemble/pipeline.ts`, `src/qa/gates.ts`, `src/select/score.ts`

### GHL adapter (`src/ghl/client.ts`)

* `GhlClient` v3 create/schedule; rejects rss + outbound; env-gated audience; sandbox spike refuses `APP_ENV=production`

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

* API/GHL fail: outbox attempts++, audit, notify placeholder, no silent loop
* Model bad JSON: retry once, qa_failed
* Invalid/malicious ingest: drop item or fail QA
* Network slow: fetch timeouts
* Database fail: collect/assemble 503
* Kill L1/L2: no clock / no outbox
* Missing GHL creds: DRY_RUN success, spike script exits with instructions
