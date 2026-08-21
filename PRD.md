# PRD: Weekly Authority Newsletter (E-02)

## 0. Assumptions

* [Confirmed] Assemble latest published posts + threat feeds into a branded issue; human approval; send.
* [Confirmed] Stack: n8n workers, GHL LC Email as ESP, Twenty as CRM projection, RSS/feeds, LLM summaries.
* [Confirmed] Depends on S-02 for **published** blog URLs, not drafts. S-02 itself is out of scope.
* [Confirmed] GHL owns the list and sends. Twenty is not the ESP.
* [Confirmed] Approver is notified by email. GET must not send.
* [Confirmed] Owner: Rafi / Growth Ops + AI Eng.
* [Assumed] Brand slug `aspire` from the folder name only. Legal name, postal address, colors, from-address, timezone, GHL IDs remain config TODOs.
* [Assumed] Audience IANA timezone defaults to `America/New_York` until filled.
* [Assumed] CISA KEV is the default official threat spine (CC0, no CISA/DHS marks). Extra RSS is allowlisted.
* [Assumed] Dual-control for the first 4 production sends.
* [Assumed] v1 HTML is applied through GHL v3 create/schedule (`editorType: html`). Exact `emailMeta` / `filter` child fields are UNVERIFIED until sandbox spike.
* [Assumed] Local fixture + DRY_RUN is the shippable engineering done-when for this repo. Live list send is a later authorized ops step.

## 1. One-Line Product Summary

Weekly Authority Newsletter helps Growth Ops ship a weekly opted-in authority email by ingesting published S-02 posts and allowlisted threat feeds, producing frozen branded HTML with mandatory human POST-approval, and broadcasting through GHL LC Email v3.

## 2. Target Users

* Primary user: Growth Ops approver (Rafi until named)
* Secondary user: AI Eng maintaining ingest/LLM/QA
* Pain: Manual assembly, unsafe auto-send, RSS-to-GHL with no HITL
* Current alternative: Hand-built GHL campaigns or native RSS schedule
* Why better: Control plane with locks, freeze, citation gates, RFC 8058 via LC Email, dummy path before prod

## 3. Problem Statement

Weekly authority email is the E-02 done-when, but naive n8n→GHL paths double-send, auto-approve via Safe Links, hallucinate CVEs, and skip unsubscribe semantics. If unsolved, either nothing ships or a list-damaging send ships. S-02 will produce ~4 posts/week; E-02 must consume published permalinks safely.

## 4. MVP Scope

* Main flow: fixtures → ingest → select → summarize → MJML+plaintext → QA → pending_approval → GET preview → POST approve → outbox (DRY_RUN does not schedule prod)
* Core input: fixture RSS + fixture KEV (later live allowlisted URLs)
* Core processing: sanitize, SSRF allowlist, score, LLM JSON or deterministic fallback, QA
* Core output: frozen HTML/text artifacts + issue row + audit
* Demo: `npm test` and `npm run assemble:fixture` and local approval GET/POST

## 5. Core User Flow

1. Clock or operator starts collect for the audience ISO week.
2. Workers ingest posts and threats into ContentItems.
3. Assemble selects, summarizes, renders, QA.
4. QA fail → qa_failed + notify. QA pass → pending_approval + staff email with inert GET links.
5. Approver opens GET page (no state change), POSTs scheduled | immediate | reject.
6. Dual-control: first N prod issues need two distinct approver ids.
7. Approve freezes SHA256, enqueues outbox. DRY_RUN / non-production refuses prod filter.
8. send-ghl worker consumes outbox. Reconcile + T+24h stats.

Empty: skip. Loading: collecting. Success: sent. Error: failed/qa_failed with audit.

## 6. Must-Have Features

### Feature: Control plane SoR

Description: Postgres is the lock and lifecycle. n8n and Twenty are not.

Acceptance criteria:

* [x] Unique issueKey
* [x] Advisory lock no-ops duplicate collect when scheduled/processing/sent
* [x] Append-only issue_events

Likely files: `src/store/`, `src/db/migrate.ts`, `migrations/001_init.sql`

### Feature: Inert approval

Description: GET/HEAD never consume tokens. POST + CSRF does.

Acceptance criteria:

* [x] GET leaves status unchanged
* [x] Second POST with same token fails
* [x] Token stored as SHA-256 only

Likely files: `src/services/control.ts`, `src/routes/approval.ts`

### Feature: Hostile ingest

Description: Feeds are untrusted.

Acceptance criteria:

* [x] Off-allowlist redirect blocked
* [x] Script/javascript stripped from titles
* [x] Extra LLM href fails QA

Likely files: `src/ingest/ssrf.ts`, `src/ingest/sanitize.ts`, `src/qa/gates.ts`

### Feature: GHL v3 broadcast only

Description: Frozen HTML via campaign create/schedule. No rss scheduleType, no conversations outbound.

Acceptance criteria:

* [x] Client rejects rss and outbound
* [x] Prod filter refused unless APP_ENV=production and DRY_RUN=false
* [x] BINDING-DECISIONS lists UNVERIFIED child fields

Likely files: `src/ghl/client.ts`, `docs/BINDING-DECISIONS.md`

## 7. Nice-to-Have Features

* High leverage: GHL pause/cancel API once spiked
* Medium: smart_send, subject A/B, Mail-Tester automation
* Low: BIMI, dedicated IP, Litmus matrix

## 8. Non-Goals

* Auto-send without POST
* Per-subscriber unique bodies beyond merge fields
* Twenty/n8n as ESP
* Cold outreach
* S-02 blog factory
* Social Fan-Out
* Drag-drop builder JSON
* Native GHL RSS campaigns
* Inventing legal entity or live URLs

## 9. System Modules

See ARCHITECTURE.md. Control plane (Fastify + Postgres), work plane (n8n JSON + in-process assemble), delivery (GHL adapter), Twenty stub.

## 10. API Specification

Public:

```txt
GET /health
Purpose: liveness, kill flags, Postgres ping when DATABASE_URL is set
Response: { ok, appEnv, dryRun, fixtureMode, killL1, killL2, db }

GET /approve/:issueKeyPath/r/:revision?t=
Purpose: inert confirmation page (sandboxed HTML iframe). GET/HEAD never consume.
POST /approve/:issueKeyPath/r/:revision
Purpose: consume hashed token + CSRF. action=scheduled|immediate|reject

GET /archive/:issueKeyPath/r/:revision?sig=
Purpose: signed unlisted frozen HTML
```

Worker API is **only** under `/internal/*` (Bearer `WORKER_TOKEN`). Unprefixed worker aliases are not served.

```txt
POST /internal/clock/tick
POST /internal/issues/:issueKeyPath/collect
POST /internal/issues/:issueKeyPath/ingest-posts
POST /internal/issues/:issueKeyPath/ingest-threats
POST /internal/issues/:issueKeyPath/assemble   body: { now? }
POST /internal/issues/:issueKeyPath/request-approval
POST /internal/outbox/drain
POST /internal/kill
POST /internal/observe
POST /internal/watchdog
POST /internal/reconcile
GET  /issues/:issueKeyPath   Bearer; JSON issue (not a send)
```

## 11. UI Specification

Approval page: issue key, revision, subject, item list with source links, HTML preview iframe (sandboxed), buttons Approve scheduled / Send now / Reject + comment. No JS auto-submit. Archive is unlisted signed URL, not /issues/latest.html.

## 12. Data Schema

See `contracts/*.schema.json` and `migrations/001_init.sql`.

## 13. AI Prompt / Model Contract

* Model: `claude-haiku-4-5` by default, overridable via `LLM_MODEL` (raise to `claude-sonnet-5` if copy quality demands it — nothing else changes).
* System: `prompts/summarizer-system.md`, sent verbatim with no interpolation, so no feed text can reach the system turn.
* Input: allow-listed ContentItems as `<source id=…>` inside `<untrusted-data>`, in the **user** turn.
* Output: `{ subject, preheader, editorBlurb, posts: [{ id, summary, ctaLabel }], threats: [{ id, whyItMatters, severity }] }` — declared in `prompts/output.schema.json`, enforced by `src/llm/schema.ts`.
* **Structured outputs constrain shape only.** Verified against `@anthropic-ai/sdk` 0.120: `maxLength`, `maxItems` and even `enum` are rewritten into a `description` hint before the request is sent. Subject length, the 5/7 item caps and the severity enum are therefore enforced *after* the call by the Zod contract — never assume the model was constrained to them.
* Guardrails: **reject** (never silently drop) any id outside the source allow-list — the allow-list is built from exactly the items in the prompt, so an unknown id is a fabricated citation; CVE substring check; href allow-list; injection canary.
* Failure: retry once on a transient API error or invalid output, then `qa_failed`. A refusal, auth failure or malformed request is not retried. A model failure never falls back to the deterministic summarizer — that would ship template copy as an AI summary with nobody told.
* Deterministic offline summarizer when `LLM_PROVIDER=fixture` or no API key. This is the CI and offline path, not a production fallback.
* No tools, no URL fetch.

## 14. Risks and Mitigations

| Risk | Impact | Mitigation |
| ---- | ------ | ---------- |
| GHL child fields unknown | Cannot go live | Binding log + sandbox spike |
| AI/API failure | No issue | Deterministic fallback + qa_failed |
| Bad output / extra links | List damage | QA + freeze + POST approve |
| Safe Links GET | Accidental send | GET inert |
| Double cron | Double send | PG lock + unique issueKey |
| Domain not warmed | Spam folder | Ops prerequisite in runbook |

## 15. Acceptance Checklist

* [x] Fixture assemble writes HTML+text without sending
* [x] Tests cover GET no-op, token once, SSRF, XSS title, extra href, CVE, rss reject, outbound reject
* [x] README documents dummy path
* [x] Production send blocked by DRY_RUN + binding log
* [ ] Sandbox GHL spike (credentials required — script present, not executed against prod)
* [ ] First live send (explicit later authorize)

## 16. Demo Script

1. Problem: weekly authority email without burning the list.
2. `npm test` — security gates.
3. `npm run assemble:fixture` — frozen issue from fixtures.
4. Open GET approve URL — scanners cannot send.
5. POST approve in DRY_RUN — outbox does not hit prod filter.
6. Binding log still UNVERIFIED for live GHL child fields.
