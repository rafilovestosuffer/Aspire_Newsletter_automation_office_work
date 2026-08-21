/**
 * Sandbox GHL spike runner.
 *
 * Fills the UNVERIFIED rows in docs/BINDING-DECISIONS.md with evidence: it
 * makes real calls against a **sandbox** sub-account and writes every
 * request/response pair to artifacts/spike/ so the log cites captured JSON
 * rather than inference.
 *
 * Hard rules, enforced here and not merely documented:
 *   - refuses APP_ENV=production outright;
 *   - only ever touches the sandbox slot;
 *   - requires an explicit seed contact list — it will not resolve an audience;
 *   - creates campaigns as drafts. Scheduling an actual send is opt-in via
 *     --schedule, because that puts mail in a real inbox.
 *
 * Usage:
 *   npm run ghl:spike                 # create a draft, read it back
 *   npm run ghl:spike -- --schedule   # also schedule to the seed contacts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnv } from "../src/env";
import { loadConfig } from "../src/config";
import { assertSandboxSpikeAllowed, GhlBanError, GhlClient, GhlHttpError } from "../src/ghl/client";
import { readBindingLog } from "../src/ghl/binding";
import { artifactsRoot } from "../src/config";

const env = loadEnv();
const config = loadConfig();
const wantSchedule = process.argv.includes("--schedule");

function out(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

try {
  assertSandboxSpikeAllowed(env.appEnv);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
}

const missing = [
  ["GHL_SANDBOX_PIT", env.GHL_SANDBOX_PIT],
  ["GHL_SANDBOX_LOCATION_ID", env.GHL_SANDBOX_LOCATION_ID],
  ["GHL_SANDBOX_USER_ID", env.GHL_SANDBOX_USER_ID],
]
  .filter(([, v]) => !String(v ?? "").trim())
  .map(([k]) => k);

const seeds = config.approvers.sandboxAudience.contactIds.filter((c) => c.trim());

if (missing.length || !seeds.length) {
  out({
    ok: false,
    reason: missing.length
      ? `Missing ${missing.join(", ")}`
      : "sandboxAudience.contactIds is empty in config/approvers.yaml",
    next: [
      "Provision a GHL sandbox sub-account (never the production location).",
      "Fill the sandbox values in .env and 1-2 seed contactIds you personally own.",
      "Run: npm run ghl:spike            (creates a draft, reads it back)",
      "Then: npm run ghl:spike -- --schedule   (sends to the seed contacts)",
      "Inspect the RAW SOURCE of the received seed message for List-Unsubscribe",
      "and List-Unsubscribe-Post, then record every capture in docs/BINDING-DECISIONS.md.",
    ],
    bindingLog: readBindingLog(),
    documented: {
      create: `POST /emails/locations/:locationId/campaigns/emails  Version ${env.GHL_API_VERSION}`,
      schedule: "POST .../campaigns/emails/:campaignId/schedule",
      forbidden: ["scheduleType=rss", "conversations outbound", "custom SMTP"],
      audienceTz: config.schedule.audienceTimeZone,
    },
  });
  process.exit(0);
}

if (env.dryRun) {
  out({
    ok: false,
    reason: "DRY_RUN=true short-circuits before any network call, so the spike would prove nothing",
    next: "Re-run with DRY_RUN=false. APP_ENV must still not be production.",
  });
  process.exit(0);
}

const captureDir = join(artifactsRoot(env.ARTIFACT_DIR), "spike");
mkdirSync(captureDir, { recursive: true });

const client = new GhlClient({
  appEnv: env.appEnv,
  dryRun: env.dryRun,
  kill: { l1: false, l2: false },
  baseUrl: env.GHL_BASE_URL,
  version: env.GHL_API_VERSION,
  sandbox: {
    locationId: env.GHL_SANDBOX_LOCATION_ID,
    userId: env.GHL_SANDBOX_USER_ID,
    pit: env.GHL_SANDBOX_PIT,
  },
  // Deliberately blank. The spike must not be able to reach production even by
  // a coding mistake in this file.
  production: { locationId: "", userId: "", pit: "" },
  bindingLogGreen: false,
  captureDir,
});

const findings: Record<string, unknown> = { apiVersion: env.GHL_API_VERSION, captureDir };
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

async function main(): Promise<void> {
  // 1. The bans must still hold against a live client.
  try {
    client.assertScheduleBody({
      scheduleType: "rss",
      timeZone: config.schedule.audienceTimeZone,
      userId: env.GHL_SANDBOX_USER_ID,
      emailMeta: { subject: "x", fromName: "x", fromEmail: config.brand.fromEmail },
      recipients: { contactIds: seeds },
    });
    findings.rssBanned = "FAIL: rss was accepted";
  } catch (err) {
    findings.rssBanned = err instanceof GhlBanError ? "ok" : String(err);
  }

  // 2. Create a draft campaign carrying real frozen-shaped HTML (Path A).
  const html = `<html><body><h1>Spike ${stamp}</h1><p>Sandbox seed only.</p>
    <p><a href="${config.brand.unsubscribeUrl}">Unsubscribe</a></p></body></html>`;

  const created = await client.createCampaign("sandbox", {
    name: `spike-${stamp}`,
    editorType: "html",
    timeZone: config.schedule.audienceTimeZone,
    userId: env.GHL_SANDBOX_USER_ID,
    editorContent: html,
  });
  findings.create = { id: created.id, status: created.status, traceId: created.traceId };

  // 3. Read it back: this is where the status enum gets confirmed.
  const fetched = await client.getCampaign("sandbox", created.id);
  findings.readBack = fetched;

  // 4. Optionally schedule to the seed contacts. This sends real mail.
  if (wantSchedule) {
    const scheduled = await client.scheduleCampaign("sandbox", created.id, {
      scheduleType: "immediate",
      timeZone: config.schedule.audienceTimeZone,
      userId: env.GHL_SANDBOX_USER_ID,
      emailMeta: {
        subject: `Spike ${stamp}`,
        fromName: config.brand.fromName,
        fromEmail: config.brand.fromEmail,
        previewText: "Sandbox spike, seed contacts only",
      },
      // contactIds, never a filter: a filter could resolve wider than intended,
      // and proving it does not is itself one of the UNVERIFIED rows.
      recipients: { contactIds: seeds },
    });
    findings.schedule = scheduled;
    findings.nextManualStep =
      "Open the received seed message and inspect its RAW SOURCE for List-Unsubscribe " +
      "and List-Unsubscribe-Post, and check DKIM alignment. That cannot be read from an API.";
  } else {
    findings.schedule = "skipped (pass --schedule to send to seed contacts)";
  }

  const summaryPath = join(captureDir, `${stamp}-summary.json`);
  writeFileSync(summaryPath, JSON.stringify(findings, null, 2));
  out({ ok: true, summaryPath, findings, reminder: "Record these in docs/BINDING-DECISIONS.md" });
}

main().catch((err) => {
  const detail =
    err instanceof GhlHttpError
      ? { status: err.status, body: err.body, traceId: err.traceId }
      : { message: err instanceof Error ? err.message : String(err) };
  // A rejected payload is evidence too: it tells the binding log what the API
  // will not accept, which is half of what the spike is for.
  out({ ok: false, findings, error: detail, captureDir });
  process.exit(1);
});
