import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config";
import { loadEnv } from "../src/env";
import { issueKeyToPath } from "../src/domain/issueKey";
import { clockTick, ingestFixtures } from "../src/services/control";
import { MemoryStore } from "../src/store/memory";

const pinned = new Date("2026-08-20T19:00:00.000Z");

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

describe("internal worker routes", () => {
  it("assemble uses request now, not a pinned calendar date", async () => {
    const env = testEnv();
    const config = loadConfig();
    const store = new MemoryStore();
    const app = await buildApp({ env, config, store });
    try {
      const tick = await clockTick({ store, env, config, now: pinned });
      await ingestFixtures(store, config);
      const path = `/internal/issues/${issueKeyToPath(tick.issueKey)}/assemble`;
      const far = await app.inject({
        method: "POST",
        url: path,
        headers: { authorization: `Bearer ${env.WORKER_TOKEN}`, "content-type": "application/json" },
        payload: { now: "2026-09-15T19:00:00.000Z" },
      });
      expect(far.statusCode).toBe(200);
      expect(far.json().status).toBe("skipped");

      await store.updateIssue(tick.issueKey, { status: "collecting" });
      const near = await app.inject({
        method: "POST",
        url: path,
        headers: { authorization: `Bearer ${env.WORKER_TOKEN}`, "content-type": "application/json" },
        payload: { now: "2026-08-20T19:00:00.000Z" },
      });
      expect(near.json().status).toBe("assembled");
    } finally {
      await app.close();
    }
  });

  it("ingest stays on fixtures when FIXTURE_MODE=true", async () => {
    const env = testEnv({ FIXTURE_MODE: "true" });
    const app = await buildApp({ env, config: loadConfig(), store: new MemoryStore() });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/internal/issues/aspire-America~New_York-2026-W34/ingest-posts",
        headers: { authorization: `Bearer ${env.WORKER_TOKEN}`, "content-type": "application/json" },
        payload: {},
      });
      expect(res.json().source).toBe("fixtures");
      expect(res.json().upserted).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });
});
