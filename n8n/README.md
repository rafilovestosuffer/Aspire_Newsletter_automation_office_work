# n8n workers (importable, inactive)

Do **not** import these into production n8n from this repo build. Import locally or to a sandbox, leave **Active = off**, and put tokens in the n8n credential store / env (`CONTROL_PLANE_URL`, `WORKER_TOKEN`, `ONCALL_WEBHOOK_URL`).

There is no `06` workflow. Approval is GET (inert) + POST on the control plane.

| File | Job | Control-plane route |
| ---- | --- | ------------------- |
| `01-clock.json` | Cron + manual tick | `POST /internal/clock/tick` |
| `02-ingest-posts.json` | CMS RSS / fixtures | `POST /internal/issues/:issueKeyPath/ingest-posts` |
| `03-ingest-threats.json` | CISA KEV / fixtures | `POST /internal/issues/:issueKeyPath/ingest-threats` |
| `04-assemble.json` | Select, LLM, MJML, QA, freeze | `POST /internal/issues/:issueKeyPath/assemble` |
| `05-request-approval.json` | Mint tokens, notify placeholder | `POST /internal/issues/:issueKeyPath/request-approval` |
| `07-send-ghl.json` | Drain outbox only | `POST /internal/outbox/drain` |
| `08-observe.json` | T+24h stats | `POST /internal/observe` |
| `09-watchdog.json` | Escalate; never auto-send | `POST /internal/watchdog` |
| `10-reconcile.json` | 15 min while in flight | `POST /internal/reconcile` |

Dummy payloads: `fixtures/n8n-dummy-payloads.json` and each workflow `pinData`.

Idempotency: Postgres/memory advisory lock + outbox key `{issueKey}:{revision}:schedule`. n8n should use concurrency 1 as defense in depth.

Error path: `Notify On-Call (placeholder)` is **disabled** and has no secret URL.
