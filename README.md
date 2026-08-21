# E-02 Weekly Authority Newsletter

Industry control plane for a weekly opted-in authority email: published S-02 posts + allowlisted threat feeds → frozen branded issue → human **POST** approval → GHL LC Email v3 broadcast.

**This repo defaults to fixtures + DRY_RUN. It will not send to a production list.**

## Quick start (dummy, no GHL)

```bash
git clone <this repo> && cd Aspire_Newsletter_automation_office_work
cp .env.example .env
npm install
npm test
npm run typecheck
npm run assemble:fixture
npm run approve:dummy
```

## Local Postgres proof

```bash
docker compose up -d postgres
export DATABASE_URL="postgres://newsletter:newsletter@127.0.0.1:5432/newsletter"
npm run migrate
npm test        # the Postgres-gated tests stop self-skipping once DATABASE_URL is set
npm run test:e2e
npm run dev
```

On Windows PowerShell, substitute `$env:DATABASE_URL="..."` for the `export`
line. Everything else is identical; the deploy target and CI are both Linux.

`GET /health` should show `db: true` after migrate. Approval GET stays inert; POST queues outbox; drain stays DRY_RUN (no live GHL HTTP).

## VPS (same stack, still DRY_RUN)

See [docs/RUNBOOK.md](docs/RUNBOOK.md). Use `docker-compose.prod.yml` + strong secrets. Do **not** import n8n. Do **not** set `DRY_RUN=false` unless a later message authorizes that one send.

```bash
cp .env.example .env   # unique APP_SECRET, WORKER_TOKEN, POSTGRES_PASSWORD
docker compose -f docker-compose.prod.yml up -d --build
# TLS: docker compose -f docker-compose.prod.yml --profile proxy up -d
```

## What runs where

| Piece | Role |
| --- | --- |
| Fastify API | Locks, approval pages, archive, kill, outbox |
| Postgres | System of record |
| `npm run assemble:fixture` | In-process assemble without n8n or GHL |
| `npm run approve:dummy` | GET inert + POST consume-once (in-memory store) |
| `n8n/*.json` | Importable workers (inactive). Do not import to production. |
| `scripts/ghl-spike.ts` / `npm run ghl:spike` | Sandbox spike only. Refuses `APP_ENV=production`. |
| `scripts/backup.sh` | `pg_dump` + copy `artifacts/` |

## Production send (blocked)

Not allowed until:

1. [docs/BINDING-DECISIONS.md](docs/BINDING-DECISIONS.md) sandbox rows are filled
2. `APP_ENV=production`, `DRY_RUN=false`, kills off
3. A human explicitly authorizes **that** send

## Docs

* [PRD.md](PRD.md)
* [ARCHITECTURE.md](ARCHITECTURE.md)
* [TASKS.md](TASKS.md)
* [docs/RUNBOOK.md](docs/RUNBOOK.md)
* [docs/COMPLIANCE.md](docs/COMPLIANCE.md)
* [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md)
