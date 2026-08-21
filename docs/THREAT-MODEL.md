# Threat model (v1)

## Assets

- Ability to send to the opted-in GHL list
- Frozen HTML that recipients will trust
- Approval tokens
- GHL PIT, LLM keys, Twenty keys
- Audit trail

## Trust boundaries

| Input | Trust | Control |
| --- | --- | --- |
| CMS RSS/REST | untrusted HTML, trusted origin if allowlisted | SSRF allowlist, sanitize, no full-text reprint |
| Threat feeds | hostile | same + citation/CVE gates |
| LLM output | untrusted | JSON schema, ID allow-list, href allow-list, injection canary |
| Approver email clients | scanners prefetch GET | GET inert; POST + CSRF consumes |
| n8n | worker, not SoR | Postgres lock + outbox idempotency |
| Twenty | projection | no send switch |

## Attacks we explicitly block in code

- SSRF via redirects off allowlist
- `javascript:` / `data:` / scripts in titles
- LLM-invented URLs or CVE IDs
- `scheduleType: rss`
- Conversations outbound
- GET/HEAD approval consume
- Double schedule of the same `issueKey` revision
- Loading prod audience filter outside `APP_ENV=production`

## Regression guard

`tests/invariants.test.ts` asserts each of these directly, organised by
invariant number, so a failure names the guarantee that broke rather than the
feature that happened to notice. It deliberately overlaps with the feature
tests: a refactor may legitimately delete `tests/approval.test.ts`, and the
"GET never sends" guarantee must not leave with it.

Every assertion there was mutation-tested — the guard was broken in the source,
the test was confirmed red, and the source restored. A test that has never been
seen to fail is not yet evidence of anything. If a change makes one of these
red, the change is wrong; do not adjust the test to match it.

Two invariants need a live database and self-gate on `DATABASE_URL`: tokens
being hashed at rest, and the `issue_events` append-only trigger. CI runs them
with a Postgres service container.

## Residual

- Human approves a meaning-drift summary that still cites the right URL
- GHL API child-field drift until spike
- Compromised staff mailbox (dual-control on first N prod issues)
