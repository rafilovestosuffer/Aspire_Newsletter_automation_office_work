# AGENTS.md

You are implementing E-02 Weekly Authority Newsletter.

## Defaults

* One session, one outcome.
* Plan and contracts before changing GHL payloads.
* Never invent client facts. TODO or ask.
* Drafts only for comms. Never send staff/marketing email unless the user explicitly authorizes that one send.
* Never push main, never edit production n8n, never live-list send unless this message authorizes that one action.

## Non-negotiable product rules

* Postgres is SoR. Twenty is projection. n8n is workers.
* Approval: GET/HEAD inert; POST consumes hashed token + CSRF.
* GHL LC Email v3 campaigns only. Forbidden: `scheduleType: rss`, conversations outbound, custom SMTP for this mail.
* SSRF allowlist. Sanitize. LLM JSON with citation allow-list.
* Kill L1 clock, L2 outbox, L3 GHL cancel. Resume-after-time = immediate send.

## Working set

Prefer `src/store`, `src/services/control.ts`, `src/routes/approval.ts`, `src/assemble/pipeline.ts`, `src/ghl/client.ts`, `docs/BINDING-DECISIONS.md`, tests.

If the chat gets worse: stop, write state into `docs/BINDING-DECISIONS.md` or issue_events, new chat.
