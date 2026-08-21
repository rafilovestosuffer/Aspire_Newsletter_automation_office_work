/**
 * Sandbox GHL spike runner. Refuses production.
 * Does not send live HTTP in this repo default (DRY_RUN / missing PIT).
 * After a real spike, record request/response in docs/BINDING-DECISIONS.md.
 */
import { loadEnv } from "../src/env";
import { loadConfig } from "../src/config";
import { assertSandboxSpikeAllowed, GhlBanError, GhlClient } from "../src/ghl/client";

const env = loadEnv();
const config = loadConfig();

try {
  assertSandboxSpikeAllowed(env.appEnv);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
}

const client = new GhlClient({
  appEnv: env.appEnv,
  dryRun: env.dryRun,
  kill: { l1: false, l2: false },
  baseUrl: env.GHL_BASE_URL,
  version: env.GHL_API_VERSION,
  sandbox: {
    locationId: env.GHL_SANDBOX_LOCATION_ID ?? "",
    userId: env.GHL_SANDBOX_USER_ID ?? "",
    pit: env.GHL_SANDBOX_PIT ?? "",
  },
  production: {
    locationId: env.GHL_PROD_LOCATION_ID ?? "",
    userId: env.GHL_PROD_USER_ID ?? "",
    pit: env.GHL_PROD_PIT ?? "",
  },
});

if (!env.GHL_SANDBOX_PIT || !env.GHL_SANDBOX_LOCATION_ID || !env.GHL_SANDBOX_USER_ID) {
  console.log(
    JSON.stringify(
      {
        ok: false,
        reason: "Missing GHL_SANDBOX_PIT, GHL_SANDBOX_LOCATION_ID, or GHL_SANDBOX_USER_ID",
        next: "Fill .env sandbox values, send to seed-only audience, inspect RFC 8058 headers, record JSON in docs/BINDING-DECISIONS.md",
        documented: {
          create: "POST /emails/locations/:locationId/campaigns/emails Version v3",
          schedule: "POST .../campaigns/emails/:campaignId/schedule",
          forbidden: ["scheduleType=rss", "conversations outbound", "custom SMTP"],
          audienceTz: config.schedule.audienceTimeZone,
        },
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

try {
  client.assertScheduleBody({
    scheduleType: "rss",
    timeZone: config.schedule.audienceTimeZone,
    userId: env.GHL_SANDBOX_USER_ID,
    emailMeta: { subject: "x", fromName: "x", fromEmail: config.brand.fromEmail },
    recipients: { contactIds: ["seed"] },
  });
} catch (err) {
  console.log(
    JSON.stringify(
      {
        ok: true,
        dryRun: env.dryRun,
        rssBanned: err instanceof GhlBanError || err instanceof Error ? err.message : String(err),
        note: "Live create/schedule is still gated. Record verified JSON after a sandbox 201.",
      },
      null,
      2,
    ),
  );
}
