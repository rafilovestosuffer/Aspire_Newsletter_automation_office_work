import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config";
import { loadEnv } from "../src/env";
import { buildIssueKey, issueKeyToPath } from "../src/domain/issueKey";
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

  // Regression: both endpoints used to run the same full ingest and ignore
  // their scope, so n8n workflows 02 and 03 duplicated each other's work.
  it("ingest-posts and ingest-threats store different content kinds", async () => {
    const env = testEnv({ FIXTURE_MODE: "true" });
    const auth = { authorization: `Bearer ${env.WORKER_TOKEN}`, "content-type": "application/json" };
    const base = "/internal/issues/aspire-America~New_York-2026-W34";

    const postStore = new MemoryStore();
    const postApp = await buildApp({ env, config: loadConfig(), store: postStore });
    try {
      const res = await postApp.inject({ method: "POST", url: `${base}/ingest-posts`, headers: auth, payload: {} });
      expect(res.json().scope).toBe("posts");
      const stored = await postStore.listContent();
      expect(stored.length).toBeGreaterThan(0);
      expect(stored.every((i) => i.kind === "post")).toBe(true);
    } finally {
      await postApp.close();
    }

    const threatStore = new MemoryStore();
    const threatApp = await buildApp({ env, config: loadConfig(), store: threatStore });
    try {
      const res = await threatApp.inject({ method: "POST", url: `${base}/ingest-threats`, headers: auth, payload: {} });
      expect(res.json().scope).toBe("threats");
      const stored = await threatStore.listContent();
      expect(stored.length).toBeGreaterThan(0);
      expect(stored.every((i) => i.kind === "threat")).toBe(true);
    } finally {
      await threatApp.close();
    }
  });

  // Regression: /collect used to call clockTick(new Date()) and ignore its own
  // path issueKey, so a named or backdated week could not be collected — it
  // silently opened whatever week "now" fell in.
  it("collect opens the issue named in the path, not the current week", async () => {
    const env = testEnv();
    const config = loadConfig();
    const store = new MemoryStore();
    const app = await buildApp({ env, config, store });
    const backdated = "aspire-America/New_York-2026-W10";
    try {
      const res = await app.inject({
        method: "POST",
        url: `/internal/issues/${issueKeyToPath(backdated)}/collect`,
        headers: { authorization: `Bearer ${env.WORKER_TOKEN}`, "content-type": "application/json" },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().issueKey).toBe(backdated);
      expect(res.json().status).toBe("collecting");

      expect(await store.getIssue(backdated)).toBeDefined();
      // The current week must not have been opened as a side effect.
      const current = buildIssueKey(config.brand.slug, config.schedule.audienceTimeZone, new Date());
      if (current !== backdated) {
        expect(await store.getIssue(current)).toBeUndefined();
      }
      // Audit trail attributes it to the operator, not the clock.
      expect(store.events.some((e) => e.eventType === "collect_opened" && e.actor === "operator")).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("collect rejects a malformed issueKey with 400 rather than a 500", async () => {
    const env = testEnv();
    const app = await buildApp({ env, config: loadConfig(), store: new MemoryStore() });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/internal/issues/not-a-real-key/collect",
        headers: { authorization: `Bearer ${env.WORKER_TOKEN}`, "content-type": "application/json" },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
