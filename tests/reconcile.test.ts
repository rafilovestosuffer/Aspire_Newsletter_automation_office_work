import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { loadEnv } from "../src/env";
import { GhlClient } from "../src/ghl/client";
import { reconcileIssues } from "../src/services/control";
import { DRY_RUN_CAMPAIGN_ID } from "../src/domain/lifecycle";
import { MemoryStore } from "../src/store/memory";
import type { IssueRow } from "../src/store/types";
import { ISSUE_SCHEMA_VERSION } from "../src/types";

function testEnv(overrides: Record<string, string> = {}) {
  return loadEnv({
    APP_ENV: "development",
    DRY_RUN: "true",
    FIXTURE_MODE: "true",
    APP_SECRET: "test-secret-at-least-32-bytes-long",
    WORKER_TOKEN: "test-worker",
    PUBLIC_BASE_URL: "http://localhost:8787",
    ...overrides,
  });
}

let seq = 0;
function scheduledIssue(patch: Partial<IssueRow> = {}): IssueRow {
  seq += 1;
  const now = new Date().toISOString();
  return {
    schemaVersion: ISSUE_SCHEMA_VERSION,
    id: `id-${seq}`,
    issueKey: `aspire-UTC-2026-W${String(30 + seq).padStart(2, "0")}`,
    brandSlug: "aspire",
    audienceTz: "UTC",
    isoWeek: `2026-W${String(30 + seq).padStart(2, "0")}`,
    revision: 1,
    status: "scheduled",
    ghlCampaignId: `camp-${seq}`,
    audienceSlot: "sandbox",
    createdAt: now,
    updatedAt: now,
    ...patch,
  };
}

/** Stub client whose getCampaign answer is fixed per test. */
class StubGhl extends GhlClient {
  constructor(private readonly answer: { status: string; dryRun?: boolean } | Error) {
    super({
      appEnv: "development",
      dryRun: false,
      kill: { l1: false, l2: false },
      baseUrl: "b",
      version: "v3",
      sandbox: { locationId: "l", userId: "u", pit: "pit" },
      production: { locationId: "l", userId: "u", pit: "pit" },
    });
  }
  override async getCampaign(_slot: "sandbox" | "production", campaignId: string) {
    if (this.answer instanceof Error) throw this.answer;
    return { id: campaignId, status: this.answer.status, dryRun: this.answer.dryRun ?? false };
  }
}

describe("reconcile", () => {
  it("moves a scheduled issue to sent when GHL reports sent, and only then counts it", async () => {
    const env = testEnv();
    const config = loadConfig();
    const store = new MemoryStore();
    const row = scheduledIssue({ sendWasDryRun: false, audienceSlot: "production" });
    store.issues.set(row.issueKey, row);

    expect(await store.countProductionSent()).toBe(0);

    const res = await reconcileIssues({ store, env, config, ghl: new StubGhl({ status: "sent" }) });

    expect(res).toMatchObject({ checked: 1, transitioned: 1 });
    const after = await store.getIssue(row.issueKey);
    expect(after?.status).toBe("sent");
    expect(after?.sentAt).toBeTruthy();
    expect(after?.ghlStatus).toBe("sent");
    expect(await store.countProductionSent()).toBe(1);
  });

  it("does not count a sandbox send toward dual control even once reconciled to sent", async () => {
    const env = testEnv();
    const config = loadConfig();
    const store = new MemoryStore();
    const row = scheduledIssue({ audienceSlot: "sandbox" });
    store.issues.set(row.issueKey, row);

    await reconcileIssues({ store, env, config, ghl: new StubGhl({ status: "sent" }) });

    expect((await store.getIssue(row.issueKey))?.status).toBe("sent");
    expect(await store.countProductionSent()).toBe(0);
  });

  it("moves processing to failed, and scheduled to cancelled/paused", async () => {
    const env = testEnv();
    const config = loadConfig();

    for (const [from, ghlStatus, to] of [
      ["processing", "failed", "failed"],
      ["scheduled", "cancelled", "cancelled"],
      ["scheduled", "paused", "paused"],
    ] as const) {
      const store = new MemoryStore();
      const row = scheduledIssue({ status: from });
      store.issues.set(row.issueKey, row);
      await reconcileIssues({ store, env, config, ghl: new StubGhl({ status: ghlStatus }) });
      expect((await store.getIssue(row.issueKey))?.status).toBe(to);
    }
  });

  it("leaves an already-matching status alone and records it as matched, not transitioned", async () => {
    const env = testEnv();
    const config = loadConfig();
    const store = new MemoryStore();
    const row = scheduledIssue({ status: "scheduled" });
    store.issues.set(row.issueKey, row);

    const res = await reconcileIssues({ store, env, config, ghl: new StubGhl({ status: "scheduled" }) });
    expect(res.matched).toBe(1);
    expect(res.transitioned).toBe(0);
  });

  it("never treats a dry-run campaign id as observable", async () => {
    const env = testEnv();
    const config = loadConfig();
    const store = new MemoryStore();
    const row = scheduledIssue({ ghlCampaignId: DRY_RUN_CAMPAIGN_ID });
    store.issues.set(row.issueKey, row);

    // Even a stub that would say "sent" must never be reached for a dry-run id.
    const res = await reconcileIssues({ store, env, config, ghl: new StubGhl({ status: "sent" }) });
    expect(res.unobservable).toBe(1);
    expect((await store.getIssue(row.issueKey))?.status).toBe("scheduled");
  });

  it("never treats a client-reported dryRun response as observable", async () => {
    const env = testEnv();
    const config = loadConfig();
    const store = new MemoryStore();
    const row = scheduledIssue();
    store.issues.set(row.issueKey, row);

    const res = await reconcileIssues({
      store,
      env,
      config,
      ghl: new StubGhl({ status: "sent", dryRun: true }),
    });
    expect(res.unobservable).toBe(1);
    expect((await store.getIssue(row.issueKey))?.status).toBe("scheduled");
  });

  it("reports draft/archived as unmapped rather than inventing a transition", async () => {
    const env = testEnv();
    const config = loadConfig();
    for (const ghlStatus of ["draft", "archived"]) {
      const store = new MemoryStore();
      const row = scheduledIssue();
      store.issues.set(row.issueKey, row);
      const res = await reconcileIssues({ store, env, config, ghl: new StubGhl({ status: ghlStatus }) });
      expect(res.unmapped).toBe(1);
      expect((await store.getIssue(row.issueKey))?.status).toBe("scheduled");
    }
  });

  it("never reconciles an issue that has not reached the outbox", async () => {
    const env = testEnv();
    const config = loadConfig();
    for (const status of ["collecting", "assembled", "pending_approval", "approved", "queued_outbox", "rejected"] as const) {
      const store = new MemoryStore();
      const row = scheduledIssue({ status, ghlCampaignId: "camp-x" });
      store.issues.set(row.issueKey, row);
      const res = await reconcileIssues({ store, env, config, ghl: new StubGhl({ status: "sent" }) });
      expect(res.checked).toBe(0);
      expect((await store.getIssue(row.issueKey))?.status).toBe(status);
    }
  });

  it("treats sent as terminal: reconcile never looks at it again", async () => {
    const env = testEnv();
    const config = loadConfig();
    const store = new MemoryStore();
    const row = scheduledIssue({ status: "sent", ghlCampaignId: "camp-x" });
    store.issues.set(row.issueKey, row);
    const res = await reconcileIssues({ store, env, config, ghl: new StubGhl({ status: "cancelled" }) });
    expect(res.checked).toBe(0);
    expect((await store.getIssue(row.issueKey))?.status).toBe("sent");
  });

  it("records a per-issue error and continues to the next issue rather than aborting the batch", async () => {
    const env = testEnv();
    const config = loadConfig();
    const store = new MemoryStore();
    const bad = scheduledIssue();
    const good = scheduledIssue();
    store.issues.set(bad.issueKey, bad);
    store.issues.set(good.issueKey, good);

    class MixedGhl extends GhlClient {
      constructor() {
        super({
          appEnv: "development",
          dryRun: false,
          kill: { l1: false, l2: false },
          baseUrl: "b",
          version: "v3",
          sandbox: { locationId: "l", userId: "u", pit: "pit" },
          production: { locationId: "l", userId: "u", pit: "pit" },
        });
      }
      override async getCampaign(_slot: "sandbox" | "production", campaignId: string) {
        if (campaignId === bad.ghlCampaignId) throw new Error("network blip");
        return { id: campaignId, status: "sent", dryRun: false };
      }
    }

    const res = await reconcileIssues({ store, env, config, ghl: new MixedGhl() });
    expect(res.errors).toBe(1);
    expect(res.transitioned).toBe(1);
    expect((await store.getIssue(bad.issueKey))?.status).toBe("scheduled");
  });
});
