# Runbook — E-02 Weekly Authority Newsletter

## On-call

| Role | Who | Contact | Backup |
| --- | --- | --- | --- |
| Primary on-call | Rafi | *fill before go-live* | *fill before go-live* |
| Approver(s) | see `config/approvers.yaml` | — | dual control on the first N production issues |
| GHL sub-account owner | *fill before go-live* | — | needed for L3 pause/cancel in the UI |

Deliberately left blank rather than guessed: an escalation path that names the
wrong person is worse than one that is obviously incomplete. Fill these in as
part of the Gate B checklist at the end of this document.

Production clock stays **off** until [BINDING-DECISIONS.md](BINDING-DECISIONS.md) is green.
n8n JSON in this repo stays `"active": false`. **Do not import to production n8n.**

## Dummy local path (no GHL send)

```bash
cp .env.example .env
npm install
npm test
npm run typecheck
npm run assemble:fixture
npm run approve:dummy
```

`assemble:fixture` writes frozen HTML/text under `artifacts/issues/`. Approval GET must not change state; POST on the local API consumes a token.

## Local Postgres E2E

```bash
docker compose up -d postgres
export DATABASE_URL="postgres://newsletter:newsletter@127.0.0.1:5432/newsletter"
npm run migrate
npm test          # Postgres-gated tests stop self-skipping once this is set
npm run test:e2e
npm run dev
```

Smoke:

1. `GET http://127.0.0.1:8787/health` → `ok: true`, `dryRun: true`, `db: true`
2. Worker: `POST /internal/clock/tick` then ingest/assemble with `Authorization: Bearer $WORKER_TOKEN`
3. Open GET approve URL — status unchanged
4. POST approve — outbox row; `POST /internal/outbox/drain` does not hit a production filter; no live GHL 201

## VPS compose (DRY_RUN)

Same code as local. Strong secrets. MemoryStore is refused when `APP_ENV=production`.

```bash
cp .env.example .env
# Set unique 32+ APP_SECRET, unique WORKER_TOKEN, unique POSTGRES_PASSWORD
# PUBLIC_BASE_URL=https://<host>
docker compose -f docker-compose.prod.yml up -d --build
# TLS reverse proxy (Caddy):
# DOMAIN=<host> docker compose -f docker-compose.prod.yml --profile proxy up -d
```

Overlay forces `DRY_RUN=true` and `FIXTURE_MODE=true`. Caddy: [deploy/Caddyfile](../deploy/Caddyfile). nginx sample: [deploy/nginx.conf.sample](../deploy/nginx.conf.sample). Fastify `trustProxy` is on.

VPS smoke (still DRY_RUN):

- `GET https://<host>/health` → `ok`, `dryRun: true`, `db: true`
- assemble fixture on the server or `POST /internal/.../assemble` with bearer
- GET approve URL — status unchanged
- POST approve — outbox; drain does not use prod filter; no GHL 201 unless a later spike

## Backups

```bash
export DATABASE_URL=postgres://...
export ARTIFACT_DIR=/data/artifacts        # or ./artifacts
export BACKUP_DIR=/var/backups/aspire-newsletter
./scripts/backup.sh
```

Writes a timestamped directory containing `newsletter.dump` (pg_dump custom
format), `artifacts.tar.gz` (frozen issues), `manifest.txt` and `SHA256SUMS`.
RPO: the last backup. Sent revisions are immutable, so an artifact restored
from any backup is byte-identical to what recipients received.

The script builds into `<stamp>.partial` and renames only on success, so a
failed run leaves nothing that could be mistaken for a usable backup. It also
refuses to finish if `pg_restore --list` cannot read the archive it just wrote.

**Scheduling.** Install [deploy/backup.crontab](../deploy/backup.crontab):
daily backup at 03:17 UTC, weekly restore drill Sunday 04:30 UTC. Cron runs
with a near-empty environment, so the crontab sets `DATABASE_URL`,
`ARTIFACT_DIR` and `BACKUP_DIR` itself — do not assume a login shell.

**Off-box.** Set `BACKUP_REMOTE` (rsync target). A backup that only exists on
the VPS does not survive losing the VPS. When it is set, a failed copy fails
the whole run; a silent skip is how you find out at restore time that nothing
ever left the box.

**Retention.** `BACKUP_RETENTION_DAYS` (default 14). The prune never deletes
the newest backup, so a job that stopped running degrades to one stale backup
rather than to none.

### Restore drill

An untested backup is not a backup.

```bash
export DATABASE_URL=postgres://...
./scripts/restore-drill.sh                  # newest backup
./scripts/restore-drill.sh 20260821T031700Z # a specific one
```

Restores into a scratch database (`newsletter_drill`), never touching
production, and checks:

- checksums match what the backup recorded;
- all eight tables came back;
- the `issue_events` append-only **trigger** came back — a restore that
  silently drops it leaves the audit trail editable with nothing looking wrong;
- restored row counts are ≤ live counts (a backup with *more* rows than live is
  not a backup of this database);
- `artifacts.tar.gz` is readable.

Exits non-zero and prints `RESTORE DRILL FAILED` on any of those. Drops the
scratch database afterwards unless `KEEP_DRILL_DB=1`.

**Record each drill** in the Gate B checklist below. A drill that nobody
recorded is indistinguishable from one that never ran.

**Verify the backup job is actually running.** The script exits non-zero and
prints a reason on every failure path, but a scheduled backup only reports that
if cron's output reaches a human. Check for a fresh timestamped directory under
`$BACKUP_DIR` — not just a quiet log.

This script shipped once with CRLF line endings, which made it die at line 3
(`set: pipefail: invalid option name`) before taking any dump — a silent no-op
backup. `.gitattributes` now pins `*.sh` to `eol=lf`; if you ever edit it on
Windows, confirm `file scripts/backup.sh` still says `LF` and that the
executable bit survived.

## Lifecycle and the workers

Status flow. Only a human POST moves an issue past `pending_approval`, and only
`reconcile` ever writes `sent`.

```
collecting → assembled → pending_approval →(human POST)→ queued_outbox
          → scheduled/processing →(reconcile)→ sent | failed | cancelled | paused
```

| Worker | Route | What it does |
| --- | --- | --- |
| drain | `POST /internal/outbox/drain` | Creates + schedules the GHL campaign. Retries transient errors with backoff; refusals dead-letter at once. |
| reconcile | `POST /internal/reconcile` | Reads campaign status from GHL and writes the terminal state. The only path to `sent`. |
| watchdog | `POST /internal/watchdog` | Escalates overdue approvals and dead-lettered outbox rows. **Never sends.** Escalations are urgent and also fan out to `ONCALL_WEBHOOK_URL`. |
| observe | `POST /internal/observe` | Declared no-op. GHL statistics field names are UNVERIFIED until the sandbox spike; a guessed payload is worse than none. |
| prune | `POST /internal/retention/prune` | Drops content outside the retention window that no issue cites. |

All take `Authorization: Bearer $WORKER_TOKEN`.

### Notification sinks

| Sink | Env | Gets |
| --- | --- | --- |
| Staff webhook | `STAFF_NOTIFY_WEBHOOK` | everything |
| Staff email | `STAFF_NOTIFY_SMTP_URL` + `_FROM` + `_TO` | everything, incl. approval links |
| On-call | `ONCALL_WEBHOOK_URL` | urgent only — overdue approval, dead-lettered outbox |

All optional and best-effort; a failing sink never breaks approval. Every
attempt writes `notify_sent` or `notify_failed` to `issue_events`, so silence
means nothing was attempted. Email is deliberately **not** LC Email — that is
the subscriber channel.

Setting two of the three email settings is treated as a misconfiguration, not
as opting out: on a host that plainly meant to send mail, silently skipping it
is the wrong reading.

### Outbox retry and dead letters

Transient failures retry up to 4 attempts with exponential backoff (60s doubling
to a 1h cap); the row stays `pending` and the issue stays `queued_outbox`.

Failures that will recur identically — empty recipients, placeholder brand
config, a missing frozen artifact, no GHL `userId` for the slot, an issue with
no subject, any `GhlBanError` — **dead-letter on the first attempt**. Retrying them only delays the escalation that gets a human
looking.

A dead letter sets the outbox row to `failed`, the issue to `failed`, and emits
`outbox_dead_letter`. To recover: fix the cause, re-assemble (which mints a new
revision), and request approval again. Do not hand-edit the outbox row.

```bash
# what is stuck and why
psql "$DATABASE_URL" -c "SELECT issue_key, attempts, last_error FROM outbox WHERE status='failed'"
```

### Dual control

The second approver is required for the first N **production** issues
(`dualControlFirstN`). That counter reads only issues that are `sent`, on the
`production` slot, with `send_was_dry_run = false` — sandbox and DRY_RUN sends
deliberately do not graduate it.

```bash
psql "$DATABASE_URL" -c "SELECT count(*) FROM issues WHERE status='sent' AND audience_slot='production' AND send_was_dry_run=false"
```

## Kills

| Level | Switch | Effect |
| --- | --- | --- |
| L1 | `KILL_SWITCH=1` or store `kill_state` L1 (`src/domain/policy.ts`) | Clock no-ops (`clockTick`) |
| L2 | `KILL_OUTBOX=1` or store `kill_state` L2 | Approved issues stay frozen; `drainOutbox` does not schedule |
| L3 | GHL UI Pause/Cancel (API UNVERIFIED — `GhlClient.pauseOrCancel`) | Stops the ESP campaign |

**Resume after original send time sends immediately** in HighLevel. Do not resume a paused campaign unless you intend to send now.

## Clock (once sandbox is allowed)

- T-48h assemble (ops TZ)
- Approval SLA until T-4h; escalate; **never auto-send**
- Send at configured audience weekday/hour
- Watchdog alerts on-call

## Incident tabletop

1. **Wrong list** — L1+L2 immediately, L3 cancel in GHL, do not resume.
2. **Safe Links hit approve URL** — GET is inert; confirm no outbox row; rotate token if needed.
3. **GHL 409** — unique `issueKey` + outbox idempotency; inspect traceId; do not retry `rss` or outbound loops.
4. **Resume-after-time** — treat as send-now; if content is wrong, cancel instead of resume.
5. **Complaint ≥ 0.1%** — warn; **≥ 0.3%** hard-stop future clocks until Postmaster recovers.

Run these as tabletops before go-live and record the date each was walked
through in the Gate B checklist. An incident procedure nobody has rehearsed is
a document, not a capability.

## Skip a week

Prefer skip (`skipped` / `skipWeeks`) over an unreviewed emergency send. RTO: miss the week.

## Gate B — first production send

Gate A is engineering-complete. **Gate B is a deliberate human authorization and
is not automated by design.** The whole architecture exists so that a send
cannot happen by accident; this checklist is the one place it happens on
purpose.

Do not tick anything from memory. Each line names how to verify it.

### Evidence

- [ ] `docs/BINDING-DECISIONS.md` has **zero** UNVERIFIED rows, each filled from
      a captured sandbox request/response, not from docs or inference
      *(enforced in code: the production audience is refused while any row is
      unverified, so this box cannot be skipped — but a row marked verified
      without real evidence defeats it, which is why the capture matters)*
- [ ] Captures in `artifacts/spike/` committed as the evidence those rows cite
- [ ] Winning send path (A/B/C) recorded with the exact accepted JSON
- [ ] v2-vs-v3 resolved empirically, with the response that proves it
- [ ] RFC 8058 `List-Unsubscribe` + `List-Unsubscribe-Post` confirmed in the
      **raw source** of a received seed message
- [ ] SPF, DKIM, DMARC (≥ `p=none`, From aligned) verified on the sending domain
- [ ] Mail-Tester ≥ 8/10 on the seed HTML
- [ ] Postmaster Tools registered for the sending domain

### Configuration

- [ ] `config/brand.yaml` free of `TODO` / `example.invalid` — `npm run assemble:fixture`
      lists any that remain
- [ ] Real physical postal address present (CAN-SPAM)
- [ ] Production audience filter proven to resolve to the intended list, and
      proven **not** to resolve wider, before any production use
- [ ] `config/approvers.yaml` lists real approvers; dual control on for first N

### Operations

- [ ] On-call table at the top of this runbook filled in
- [ ] Backups scheduled (`deploy/backup.crontab` installed) and a fresh backup present
- [ ] **Restore drill passed** — date: ________, by: ________
- [ ] `BACKUP_REMOTE` configured, or the single-host risk explicitly accepted
- [ ] All five incident tabletops walked through — date: ________
- [ ] Kill switches L1/L2 tested on this deployment
- [ ] L3 (GHL UI pause/cancel) located and understood: **resume after the
      original send time sends immediately — cancel, never resume**

### Verification

- [ ] CI green including the Postgres job
- [ ] Approval URL opened in Gmail *and* Outlook; Safe Links prefetch left the
      issue status unchanged
- [ ] Frozen HTML rendered in Gmail / Outlook / Apple Mail, under the 102 KB clip
- [ ] Full DRY_RUN rehearsal on the production host: clock → ingest → assemble →
      GET inert → POST → drain → reconcile

### The switch

Only after every box above:

- [ ] `APP_ENV=production`
- [ ] `DRY_RUN=false`
- [ ] `KILL_SWITCH` / `KILL_OUTBOX` off
- [ ] Authorized by: ________  date: ________

Sign-off is a person, not a deploy script.
