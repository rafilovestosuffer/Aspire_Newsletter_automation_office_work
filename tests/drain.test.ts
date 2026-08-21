import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { loadEnv } from "../src/env";
import { artifactDirFor } from "../src/assemble/pipeline";
import { artifactsRoot } from "../src/config";
import {
  assembleIssue,
  clockTick,
  consumeApproval,
  drainOutbox,
  ingestFixtures,
  requestApproval,
} from "../src/services/control";
import { csrfForToken } from "../src/domain/hash";
import { GhlClient, type CreateCampaignBody, type ScheduleCampaignBody } from "../src/ghl/client";
import { resolveDrainRecipients } from "../src/ghl/audience";
import { MemoryStore } from "../src/store/memory";
import type { AppConfig } from "../src/types";

const now = new Date("2026-08-20T19:00:00.000Z");

function testEnv(overrides: Record<string, string> = {}) {
  return loadEnv({
    APP_ENV: "development",
    DRY_RUN: "true",
    FIXTURE_MODE: "true",
    ALLOW_TOKEN_ECHO: "1",
    APP_SECRET: "test-secret-at-least-32-bytes-long",
    WORKER_TOKEN: "test-worker",
    PUBLIC_BASE_URL: "http://localhost:8787",
    ...overrides,
  });
}

function withAudience(
  config: AppConfig,
  patch: {
    contactIds?: string[];
    filter?: Record<string, unknown>;
  },
): AppConfig {
  return {
    ...config,
    approvers: {
      ...config.approvers,
      sandboxAudience: {
        ...config.approvers.sandboxAudience,
        contactIds: patch.contactIds ?? config.approvers.sandboxAudience.contactIds,
      },
      productionAudience: {
        ...config.approvers.productionAudience,
        filter: patch.filter ?? config.approvers.productionAudience.filter,
      },
    },
  };
}

class RecordingGhl extends GhlClient {
  lastEditorContent?: string;
  lastRecipients?: ScheduleCampaignBody["recipients"];
  createCalls = 0;

  override async createCampaign(slot: "sandbox" | "production", body: CreateCampaignBody) {
    this.createCalls += 1;
    this.lastEditorContent = body.editorContent;
    return super.createCampaign(slot, body);
  }

  override async scheduleCampaign(
    slot: "sandbox" | "production",
    campaignId: string,
    body: ScheduleCampaignBody,
  ) {
    this.lastRecipients = body.recipients;
    return super.scheduleCampaign(slot, campaignId, body);
  }
}

async function queueIssue(opts: { env: ReturnType<typeof testEnv>; config: AppConfig; store: MemoryStore }) {
  const tick = await clockTick({ store: opts.store, env: opts.env, config: opts.config, now });
  await ingestFixtures(opts.store, opts.config);
  const assembled = await assembleIssue({
    store: opts.store,
    env: opts.env,
    config: opts.config,
    issueKey: tick.issueKey,
    now,
  });
  expect(assembled.status).toBe("assembled");
  const minted = await requestApproval({
    store: opts.store,
    env: opts.env,
    config: opts.config,
    issueKey: tick.issueKey,
  });
  const token = minted.tokens![0]!;
  const posted = await consumeApproval({
    store: opts.store,
    env: opts.env,
    config: opts.config,
    rawToken: token.token,
    csrf: csrfForToken(opts.env.APP_SECRET, token.token),
    action: "scheduled",
    comment: "",
    approverId: token.approverId,
  });
  expect(posted.issueStatus).toBe("queued_outbox");
  return { issueKey: tick.issueKey, revision: assembled.revision };
}

describe("drainOutbox audience + frozen HTML", () => {
  it("refuses empty sandbox contactIds without calling GHL", async () => {
    const env = testEnv();
    const config = withAudience(loadConfig(), { contactIds: [] });
    const store = new MemoryStore();
    const ghl = new RecordingGhl({
      appEnv: env.appEnv,
      dryRun: true,
      kill: { l1: false, l2: false },
      baseUrl: env.GHL_BASE_URL,
      version: env.GHL_API_VERSION,
      sandbox: { locationId: "", userId: "", pit: "" },
      production: { locationId: "", userId: "", pit: "" },
    });
    await queueIssue({ env, config, store });
    const result = await drainOutbox({ store, env, config, limit: 10, ghl });
    expect(result.failed).toBe(1);
    expect(ghl.createCalls).toBe(0);
    const job = [...store.outbox.values()][0];
    expect(job?.lastError).toMatch(/contactIds is empty/);
  });

  it("uploads frozen artifact HTML, not a placeholder string", async () => {
    const env = testEnv();
    const config = withAudience(loadConfig(), { contactIds: ["seed-fixture"] });
    const store = new MemoryStore();
    const ghl = new RecordingGhl({
      appEnv: env.appEnv,
      dryRun: true,
      kill: { l1: false, l2: false },
      baseUrl: env.GHL_BASE_URL,
      version: env.GHL_API_VERSION,
      sandbox: { locationId: "", userId: "", pit: "" },
      production: { locationId: "", userId: "", pit: "" },
    });
    const queued = await queueIssue({ env, config, store });
    const result = await drainOutbox({ store, env, config, limit: 10, ghl });
    expect(result.processed).toBe(1);
    expect(ghl.lastEditorContent).toBeTruthy();
    expect(ghl.lastEditorContent).not.toBe("DRY_RUN frozen html not uploaded");
    expect(ghl.lastEditorContent).toMatch(/<!doctype html/i);
    expect(ghl.lastRecipients).toEqual({ contactIds: ["seed-fixture"] });
    const drained = store.events.find((e) => e.eventType === "outbox_drained");
    expect((drained?.payload as { htmlSha256?: string })?.htmlSha256).toBeTruthy();
    expect((await store.getIssue(queued.issueKey))?.status).toBe("scheduled");
  });

  it("fails the job when frozen HTML is missing", async () => {
    const env = testEnv();
    const config = withAudience(loadConfig(), { contactIds: ["seed-fixture"] });
    const store = new MemoryStore();
    const ghl = new RecordingGhl({
      appEnv: env.appEnv,
      dryRun: true,
      kill: { l1: false, l2: false },
      baseUrl: env.GHL_BASE_URL,
      version: env.GHL_API_VERSION,
      sandbox: { locationId: "", userId: "", pit: "" },
      production: { locationId: "", userId: "", pit: "" },
    });
    const queued = await queueIssue({ env, config, store });
    const file = join(
      artifactDirFor(artifactsRoot(env.ARTIFACT_DIR), queued.issueKey, queued.revision),
      "email.html",
    );
    unlinkSync(file);
    const result = await drainOutbox({ store, env, config, limit: 10, ghl });
    expect(result.failed).toBe(1);
    expect(ghl.createCalls).toBe(0);
    expect([...store.outbox.values()][0]?.lastError).toMatch(/frozen html missing/);
  });

  it("production slot uses filter, never sandbox contactIds, and refuses {}", async () => {
    expect(
      resolveDrainRecipients({
        slot: "production",
        sandboxContactIds: ["seed-fixture"],
        productionFilter: {},
      }).ok,
    ).toBe(false);

    const queueEnv = testEnv();
    const drainEnv = testEnv({
      APP_ENV: "production",
      DRY_RUN: "false",
      APP_SECRET: "prod-secret-at-least-32-bytes-ok",
      WORKER_TOKEN: "prod-worker-token-16",
    });
    const config = withAudience(loadConfig(), {
      contactIds: ["seed-fixture"],
      filter: { TODO_unverified: "do-not-invent-ghl-keys" },
    });
    const store = new MemoryStore();
    const ghl = new RecordingGhl({
      appEnv: "production",
      dryRun: false,
      kill: { l1: false, l2: false },
      baseUrl: drainEnv.GHL_BASE_URL,
      version: drainEnv.GHL_API_VERSION,
      sandbox: { locationId: "", userId: "", pit: "" },
      production: { locationId: "", userId: "", pit: "" },
    });
    await queueIssue({ env: queueEnv, config, store });
    const result = await drainOutbox({ store, env: drainEnv, config, limit: 10, ghl });
    expect(result.processed).toBe(1);
    expect(ghl.lastRecipients).toEqual({ filter: { TODO_unverified: "do-not-invent-ghl-keys" } });
    expect(ghl.lastRecipients).not.toHaveProperty("contactIds");
  });
});
