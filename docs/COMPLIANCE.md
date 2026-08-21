# Compliance pack (v1)

This newsletter is commercial email. Follow the **stricter** of overlapping rules.

## CAN-SPAM (FTC)

- Accurate From / Reply-To / routing. Identify the real business.
- Subject must match the body. No deceptive subjects.
- Valid physical postal address in the footer (street, USPS PO box, or CMRA box). Config `postalAddress` in `config/brand.yaml.example` is TODO until filled. LC Email is the send path; custom SMTP is forbidden.

  **Enforced in code.** `brandCompletenessProblems()` (`src/qa/gates.ts`) rejects any brand field that is empty or still carries `TODO` / `example.invalid` / `replace-with`. It runs twice:
  - at assemble, as a QA **warning** in development (so the gap is visible from day one) and a QA **failure** everywhere else, so a placeholder issue never reaches approval;
  - at drain, as a hard refusal for the production audience, because config can change between assemble and send.

  Sandbox seed sends are exempt — spike sends legitimately run on scaffolding. Run `npm run assemble:fixture` to list exactly which fields are still outstanding.
- Clear opt-out. Honor opt-outs. Gmail bulk senders: honor within **48 hours** (stricter than CAN-SPAM 10 business days).
- If the primary purpose is commercial, identify the message as an ad (`advertisementNotice`).
- You cannot contract away liability to GHL or this repo.

## Gmail / Yahoo sender requirements

Implemented from issue 1 even if volume is under 5,000/day:

- SPF and DKIM on the LC Email dedicated domain for this sub-account only.
- DMARC at least `p=none`, From aligned.
- PTR / TLS / RFC 5322 (ESP).
- Visible unsubscribe + RFC 8058 one-click (`List-Unsubscribe` + `List-Unsubscribe-Post`). **LC Email required.** Custom SMTP is forbidden for this product.
- Postmaster spam < 0.3%; warn at 0.1%.

Proof: seed message source after sandbox spike, recorded in BINDING-DECISIONS.md.

## List

- Audience = explicit opt-in tag/smart list. No cold list on this domain.
- GHL email validation on. Suppress DND / unsubscribed / hard bounce.
- Sunset: 90 days no engagement → re-permission or suppress (document in GHL; automate v1.5).

## Content / licensing

- CISA KEV is CC0. Do **not** use CISA or DHS logos or imply endorsement.
- Do not reprint full third-party RSS `content:encoded`. Original short summaries + link.
- NVD API is out of v1. If added later, display NIST’s disclaimer.
- Public intel only. No internal IOCs.

## PII

Do not copy the GHL subscriber list into Postgres or Twenty. Store campaign ids, counts, and stats only.
