# CLAUDE.md

## Project Context

This is a production-shaped newsletter **control plane**, not a hackathon demo and not a live ESP blast.

Priorities:

1. Do not send to a real list
2. Do not import production n8n
3. Keep GET approval inert
4. Keep GHL `rss` and conversations outbound forbidden
5. Block-by-block changes with tests
6. Never invent client legal facts, GHL IDs, or mark UNVERIFIED API fields as verified

## Source of Truth

1. Latest user instruction
2. `TASKS.md`
3. `PRD.md` / `ARCHITECTURE.md`
4. `docs/BINDING-DECISIONS.md` for GHL
5. `CLAUDE.md` / `AGENTS.md`

## Workflow

1. Implement exactly one TASKS.md block unless the user asked to complete all
2. Do not refactor unrelated files
3. Run `npm test` and relevant scripts
4. Report files, tests, risks, next step

## Coding Rules

* TypeScript strict
* Secrets only in env / n8n credential store
* `DRY_RUN` defaults true
* Prod audience filter only if `APP_ENV=production` AND `DRY_RUN=false` AND kills off
* Untrusted feed text never treated as LLM instructions
* hrefs in HTML must be ingest URLs or config brand/unsub/archive/preference or mailto of fromDomain
* No CISA/DHS logos
* Do not copy GHL subscriber lists into Postgres/Twenty

## Testing Rules

```bash
npm test
npm run typecheck
npm run assemble:fixture
```

Skip live `npm run ghl:spike` unless sandbox PIT is present and `APP_ENV` is not production.

## Final Response Format

After a block:

```md
# Block Completed: [Name]
## What changed
## Files changed
## Commands run
## Test result
## Risks / limitations
## Next recommended step
```
