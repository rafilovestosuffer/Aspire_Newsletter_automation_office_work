import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { loadEnv } from "../src/env";
import { assembleIssue, clockTick, ingestFixtures } from "../src/services/control";
import { MemoryStore } from "../src/store/memory";
import { TERMINAL_NOOP_STATUSES } from "../src/types";
import { outboxIdempotencyKey } from "../src/domain/policy";

const now = new Date("2026-08-20T19:00:00.000Z");

describe("issueKey lock / idempotency", () => {
  it("concurrent assemble serializes and terminal status no-ops", async () => {
    const env = loadEnv({
      APP_ENV: "development",
      DRY_RUN: "true",
      FIXTURE_MODE: "true",
      APP_SECRET: "test-secret-at-least-32-bytes-long",
      WORKER_TOKEN: "test-worker",
    });
    const config = loadConfig();
    const store = new MemoryStore();
    const tick = await clockTick({ store, env, config, now });
    expect(tick.issueKey).toContain("2026-W34");
    await ingestFixtures(store, config);

    const [a, b] = await Promise.all([
      assembleIssue({ store, env, config, issueKey: tick.issueKey, now }),
      assembleIssue({ store, env, config, issueKey: tick.issueKey, now }),
    ]);
    expect(a.status).toBe("assembled");
    expect(b.status).toBe("assembled");
    expect(a.revision).toBe(1);
    expect(b.revision).toBe(1);

    await store.updateIssue(tick.issueKey, { status: "sent" });
    const again = await clockTick({ store, env, config, now });
    expect(TERMINAL_NOOP_STATUSES.has(again.status as "sent")).toBe(true);
    expect(again.noOpReason).toMatch(/terminal/);
    expect(outboxIdempotencyKey(tick.issueKey, 1)).toBe(`${tick.issueKey}:1:schedule`);
  });
});
