import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { loadEnv } from "../src/env";
import { runWatchdog } from "../src/services/control";
import { MemoryStore } from "../src/store/memory";
import type { IssueRow } from "../src/store/types";
import { ISSUE_SCHEMA_VERSION, TERMINAL_NOOP_STATUSES, type IssueStatus } from "../src/types";

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
function issueRow(status: IssueStatus, updatedAt: string): IssueRow {
  seq += 1;
  return {
    schemaVersion: ISSUE_SCHEMA_VERSION,
    id: `id-${seq}`,
    issueKey: `aspire-UTC-2026-W${String(10 + seq).padStart(2, "0")}`,
    brandSlug: "aspire",
    audienceTz: "UTC",
    isoWeek: `2026-W${String(10 + seq).padStart(2, "0")}`,
    revision: 1,
    status,
    createdAt: updatedAt,
    updatedAt,
  };
}

const now = new Date("2026-08-20T12:00:00.000Z");

describe("watchdog", () => {
  it("escalates a pending_approval issue past the SLA and leaves it pending_approval", async () => {
    const env = testEnv();
    const config = loadConfig();
    const store = new MemoryStore();
    // SLA in config/schedule.yaml.example is 4h; put this well past it.
    const stale = issueRow("pending_approval", new Date(now.getTime() - 10 * 3_600_000).toISOString());
    store.issues.set(stale.issueKey, stale);

    const res = await runWatchdog({ store, env, config, now });

    expect(res.staleApprovals).toBe(1);
    expect(res.escalated).toBe(1);
    // The one property that matters most: escalation never changes the status.
    expect((await store.getIssue(stale.issueKey))?.status).toBe("pending_approval");
    expect(store.events.some((e) => e.eventType === "watchdog_approval_overdue")).toBe(true);
  });

  it("does not escalate a pending_approval issue still inside the SLA", async () => {
    const env = testEnv();
    const config = loadConfig();
    const store = new MemoryStore();
    const fresh = issueRow("pending_approval", new Date(now.getTime() - 60_000).toISOString());
    store.issues.set(fresh.issueKey, fresh);

    const res = await runWatchdog({ store, env, config, now });
    expect(res.staleApprovals).toBe(0);
    expect(res.escalated).toBe(0);
  });

  it("escalates a dead-lettered outbox row without touching the issue", async () => {
    const env = testEnv();
    const config = loadConfig();
    const store = new MemoryStore();
    const failedIssue = issueRow("failed", now.toISOString());
    store.issues.set(failedIssue.issueKey, failedIssue);
    store.outbox.set("idem-1", {
      id: "outbox-1",
      idempotencyKey: "idem-1",
      issueKey: failedIssue.issueKey,
      revision: 1,
      payload: {},
      status: "failed",
      attempts: 4,
      lastError: "refusing production send with incomplete brand config",
    });

    const res = await runWatchdog({ store, env, config, now });
    expect(res.deadLetters).toBe(1);
    expect(res.escalated).toBe(1);
    expect((await store.getIssue(failedIssue.issueKey))?.status).toBe("failed");
    expect(store.events.some((e) => e.eventType === "watchdog_outbox_dead_letter")).toBe(true);
  });

  // The property that matters most in this whole file: no matter what the
  // watchdog finds, it never has a way to move an issue toward a send. It only
  // appends events and notifies; TERMINAL_NOOP_STATUSES (scheduled, processing,
  // sent) are never even inspected, let alone reachable, from here.
  it("has no write path toward any sending status", async () => {
    const env = testEnv();
    const config = loadConfig();
    const store = new MemoryStore();
    const before = new Map(
      [...TERMINAL_NOOP_STATUSES, "queued_outbox", "approved"].map((status, i) => {
        const row = issueRow(status as IssueStatus, now.toISOString());
        store.issues.set(row.issueKey, row);
        return [row.issueKey, row.status];
      }),
    );

    await runWatchdog({ store, env, config, now });

    for (const [key, status] of before) {
      expect((await store.getIssue(key))?.status).toBe(status);
    }
  });

  it("processes multiple stale approvals and dead letters in one pass", async () => {
    const env = testEnv();
    const config = loadConfig();
    const store = new MemoryStore();
    const stale1 = issueRow("pending_approval", new Date(now.getTime() - 24 * 3_600_000).toISOString());
    const stale2 = issueRow("pending_approval", new Date(now.getTime() - 5 * 3_600_000).toISOString());
    store.issues.set(stale1.issueKey, stale1);
    store.issues.set(stale2.issueKey, stale2);
    store.outbox.set("idem-a", {
      id: "outbox-a",
      idempotencyKey: "idem-a",
      issueKey: "some-issue",
      revision: 1,
      payload: {},
      status: "failed",
      attempts: 4,
      lastError: "boom",
    });

    const res = await runWatchdog({ store, env, config, now });
    expect(res.staleApprovals).toBe(2);
    expect(res.deadLetters).toBe(1);
    expect(res.escalated).toBe(3);
  });
});
