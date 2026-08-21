import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config";
import { loadEnv } from "../src/env";
import { MemoryStore } from "../src/store/memory";

describe("GET /health", () => {
  it("is ok without Postgres and reports db false", async () => {
    const env = loadEnv({
      APP_ENV: "development",
      DRY_RUN: "true",
      FIXTURE_MODE: "true",
      APP_SECRET: "test-secret-at-least-32-bytes-long",
      WORKER_TOKEN: "test-worker",
      DATABASE_URL: "",
    });
    const app = await buildApp({ env, config: loadConfig(), store: new MemoryStore() });
    try {
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { ok: boolean; db: boolean; dryRun: boolean };
      expect(body.ok).toBe(true);
      expect(body.db).toBe(false);
      expect(body.dryRun).toBe(true);
    } finally {
      await app.close();
    }
  });
});
