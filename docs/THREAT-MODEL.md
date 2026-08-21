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

## Residual

- Human approves a meaning-drift summary that still cites the right URL
- GHL API child-field drift until spike
- Compromised staff mailbox (dual-control on first N prod issues)
