import { describe, expect, it } from "vitest";
import pg from "pg";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config";
import { loadEnv } from "../src/env";
import { csrfForToken, sha256Hex } from "../src/domain/hash";
import { issueKeyToPath } from "../src/domain/issueKey";
import { migrate } from "../src/db/migrate";
import {
  assembleIssue,
  clockTick,
  consumeApproval,
  drainOutbox,
  ingestFixtures,
  requestApproval,
} from "../src/services/control";
import { PostgresStore } from "../src/store/postgres";
import type { AppConfig } from "../src/types";

const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";

function uniqueConfig(contactIds: string[]): AppConfig {
  const config = loadConfig();
  return {
    ...config,
    brand: { ...config.brand, slug: `e2e${Date.now()}` },
    approvers: {
      ...config.approvers,
      sandboxAudience: { ...config.approvers.sandboxAudience, contactIds },
    },
  };
}

describe.skipIf(!databaseUrl)("Postgres E2E (set DATABASE_URL)", () => {
  it("clock → ingest → assemble → GET inert → POST → drain DRY_RUN", async () => {
    await migrate(databaseUrl);
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const store = new PostgresStore(pool);
    const env = loadEnv({
      APP_ENV: "development",
      DRY_RUN: "true",
      FIXTURE_MODE: "true",
      ALLOW_TOKEN_ECHO: "1",
      DATABASE_URL: databaseUrl,
      APP_SECRET: "test-secret-at-least-32-bytes-long",
      WORKER_TOKEN: "test-worker",
      PUBLIC_BASE_URL: "http://localhost:8787",
      // A real deployment always has a sender for its slot; drain refuses to
      // send without one rather than falling back to scaffolding.
      GHL_SANDBOX_LOCATION_ID: "loc-sb",
      GHL_SANDBOX_USER_ID: "user-sb",
    });
    const config = uniqueConfig(["seed-fixture"]);
    const now = new Date("2026-08-20T19:00:00.000Z");
    const app = await buildApp({ env, config, store });
    try {
      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.json().ok).toBe(true);
      expect(health.json().db).toBe(true);

      const tick = await clockTick({ store, env, config, now });
      expect(tick.status).toBe("collecting");
      await ingestFixtures(store, config);
      const assembled = await assembleIssue({ store, env, config, issueKey: tick.issueKey, now });
      expect(assembled.status).toBe("assembled");
      const minted = await requestApproval({ store, env, config, issueKey: tick.issueKey });
      const token = minted.tokens![0]!;
      const path = `/approve/${issueKeyToPath(tick.issueKey)}/r/${assembled.revision}`;

      const get1 = await app.inject({ method: "GET", url: `${path}?t=${token.token}` });
      expect(get1.statusCode).toBe(200);
      expect((await store.getTokenByHash(sha256Hex(token.token)))?.consumedAt).toBeNull();

      const posted = await consumeApproval({
        store,
        env,
        config,
        rawToken: token.token,
        csrf: csrfForToken(env.APP_SECRET, token.token),
        action: "scheduled",
        comment: "",
        approverId: token.approverId,
      });
      expect(posted.issueStatus).toBe("queued_outbox");

      const drained = await drainOutbox({ store, env, config, limit: 10 });
      expect(drained.processed).toBe(1);
      expect((await store.getIssue(tick.issueKey))?.status).toBe("scheduled");
    } finally {
      await app.close();
      await pool.end();
    }
  });
});
