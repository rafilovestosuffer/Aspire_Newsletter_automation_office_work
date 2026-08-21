# Runbook — E-02 Weekly Authority Newsletter

On-call: Rafi until a named replacement is written here. TODO.

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
npm run migrate
# PowerShell
$env:DATABASE_URL="postgres://newsletter:newsletter@127.0.0.1:5432/newsletter"
npm test
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
export ARTIFACT_DIR=/data/artifacts   # or ./artifacts
bash scripts/backup.sh
```

Postgres dump + copy of `artifacts/`. RPO: last backup. Sent revisions are immutable. Cron daily on the VPS.

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

## Incident tabletop (practice these)

1. **Wrong list** — L1+L2 immediately, L3 cancel in GHL, do not resume.
2. **Safe Links hit approve URL** — GET is inert; confirm no outbox row; rotate token if needed.
3. **GHL 409** — unique `issueKey` + outbox idempotency; inspect traceId; do not retry `rss` or outbound loops.
4. **Resume-after-time** — treat as send-now; if content is wrong, cancel instead of resume.
5. **Complaint ≥ 0.1%** — warn; **≥ 0.3%** hard-stop future clocks until Postmaster recovers.

## Skip a week

Prefer skip (`skipped` / `skipWeeks`) over an unreviewed emergency send. RTO: miss the week.
