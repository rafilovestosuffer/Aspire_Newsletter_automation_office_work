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

## Known dependency advisories

`npm audit --omit=dev` reports 32 high-severity advisories. All 32 are the same
root cause: mjml depends on `html-minifier <=4.0.0`, which carries a ReDoS
(GHSA-pfq8-rq6v-vf5m). There is no patched release — 4.0.0 is the latest, and
the fix only exists in mjml 5, which migrates to `html-minifier-terser`.

**Not currently reachable.** `mjml-core` calls the minifier only when the
`minify` option is true (`mjml-core/lib/index.js`: `if (minify)`), and
`src/render/compile.ts` passes `minify: false`. `tests/qa.test.ts` pins that
flag, so the mitigation cannot be undone by a tidy-up.

This matters because feed-derived text reaches the rendered HTML: with
minification on, an attacker-influenced excerpt would be the minifier's input.

**Upgrading is deliberate work, not a quick `npm audit fix`.** mjml 5 is a
semver-major and will change rendered bytes, which changes every frozen
artifact hash. Doing it means re-verifying the fixture hash, re-rendering in
Gmail / Outlook / Apple Mail, and re-checking the 102 KB clip budget.

## Residual

- Human approves a meaning-drift summary that still cites the right URL
- GHL API child-field drift until spike
- Compromised staff mailbox (dual-control on first N prod issues)
