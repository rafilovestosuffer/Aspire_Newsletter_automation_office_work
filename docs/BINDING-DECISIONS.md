# Binding Decision Log

This file is the go-live gate. **No production clock and no live list send until the UNVERIFIED rows below are filled from a sandbox spike** and a human authorizes that send.

Do not mark a field VERIFIED from blog posts or guessed JSON.

## Environments

| Env | GHL location | Audience | Clock allowed |
| --- | --- | --- | --- |
| development | none / mock | fixtures | local dummy only |
| sandbox | `GHL_SANDBOX_LOCATION_ID` | seed-only filter or seed `contactIds` | yes after spike |
| production | `GHL_PROD_LOCATION_ID` | opted-in `newsletter-weekly` filter | only if this log is green, `DRY_RUN=false`, kills off, and send is explicitly authorized |

## HighLevel Email v3 — documented (not sub-account-proven)

Source: HighLevel marketplace docs, retrieved 2026-08-20.

| Item | Status | Evidence |
| --- | --- | --- |
| Base URL `https://services.leadconnectorhq.com` | VERIFIED-DOCS | marketplace API |
| Header `Version: v3` on email campaign routes | VERIFIED-DOCS | Create Email Campaign v3 |
| `POST /emails/locations/:locationId/campaigns/emails` | VERIFIED-DOCS | Create Email Campaign v3 |
| Create required: `name`, `editorType` (`html`\|`text`), `timeZone`, `userId` | VERIFIED-DOCS | same |
| Create optional: `templateId`, `editorContent` (HTML/text string) | VERIFIED-DOCS | same |
| `editorType: builder` programmatic | FORBIDDEN | HighLevel GitHub issue #280: builder JSON not supported |
| Campaign statuses include draft, scheduled, processing, sent, failed, cancelled, paused, archived | VERIFIED-DOCS | create response schema |
| `POST /emails/locations/:locationId/campaigns/emails/:campaignId/schedule` | VERIFIED-DOCS | Schedule Campaign v3 |
| Schedule only if campaign is draft, cancelled, or paused | VERIFIED-DOCS | same |
| Schedule required: `scheduleType`, `timeZone`, `userId`, `emailMeta`, `recipients` | VERIFIED-DOCS | same |
| `scheduleType` enum: immediate, scheduled, batch, rss, smart_send | VERIFIED-DOCS | same |
| This product `scheduleType` | DECISION | v1 uses `scheduled`; `immediate` only after POST-confirm send-now |
| `scheduleType: rss` | FORBIDDEN | bypasses HITL/LLM/threats/QA |
| `recipients` must be `contactIds` OR `filter` | VERIFIED-DOCS | schedule body |
| `POST /conversations/messages/outbound` | FORBIDDEN | 1:1 mail; wrong unsub; rate limits |
| Custom SMTP for this newsletter | FORBIDDEN | RFC 8058 headers not reliably injected; LC Email required |
| LC Email injects `List-Unsubscribe` + `List-Unsubscribe-Post` | VERIFIED-DOCS | HighLevel ideas/support (LC Email / Mailgun). Must be **proven on a seed message** |
| Pause/Cancel in Email Marketing UI | VERIFIED-DOCS | support article 155000003462. Resume after original time **sends immediately** |
| `PATCH /emails/builder/:templateId` html/text | VERIFIED-DOCS | Email Template Update API. Winning HTML path still a spike |

## Must be filled by sandbox spike (UNVERIFIED)

| Item | Status | Winning JSON / notes |
| --- | --- | --- |
| Exact `emailMeta` child fields that accept frozen HTML | UNVERIFIED | |
| Exact `recipients.filter` schema for a tag or smart list | UNVERIFIED | |
| Seed-only audience that cannot resolve the full list | UNVERIFIED | |
| Pause/cancel **API** vs UI-only | UNVERIFIED | Until proven, L3 kill is UI cancel |
| Preference category assignment via API | UNVERIFIED | |
| Statistics V2/V3 field names | UNVERIFIED | |
| Raw seed message contains RFC 8058 headers, DKIM-covered | UNVERIFIED | Inspect full source |
| Mail-Tester score on seed HTML | UNVERIFIED | Hold default 8/10 |

## Winning send path (fill after spike)

- [ ] Path A: create campaign with `editorContent` HTML, then schedule with `emailMeta` + `filter`
- [ ] Path B: template PATCH html, then create from `templateId`, then schedule
- [ ] Path C: other (describe)

**Chosen path:** _empty until spike_

## Sign-off

| Gate | Owner | Date | Result |
| --- | --- | --- | --- |
| Sandbox spike | | | |
| Dress rehearsal | | | |
| First production send authorized in chat | | | blocked |
