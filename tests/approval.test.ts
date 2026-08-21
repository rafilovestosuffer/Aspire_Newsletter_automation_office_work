import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config";
import { loadEnv } from "../src/env";
import { csrfForToken, sha256Hex } from "../src/domain/hash";
import { issueKeyToPath } from "../src/domain/issueKey";
import { assembleIssue, clockTick, ingestFixtures, requestApproval } from "../src/services/control";
import { MemoryStore } from "../src/store/memory";

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

describe("approval GET inert / POST consume", () => {
  it("GET and HEAD do not consume; POST consumes once", async () => {
    const env = testEnv();
    const config = loadConfig();
    const store = new MemoryStore();
    const app = await buildApp({ env, config, store });
    try {
      const tick = await clockTick({ store, env, config, now });
      await ingestFixtures(store, config);
      const assembled = await assembleIssue({ store, env, config, issueKey: tick.issueKey, now });
      expect(assembled.status).toBe("assembled");
      const minted = await requestApproval({ store, env, config, issueKey: tick.issueKey });
      const token = minted.tokens?.[0];
      expect(token).toBeTruthy();
      const path = `/approve/${issueKeyToPath(tick.issueKey)}/r/${assembled.revision}`;

      const get1 = await app.inject({ method: "GET", url: `${path}?t=${token!.token}` });
      expect(get1.statusCode).toBe(200);
      expect(get1.body).toContain("GET and HEAD do nothing");
      expect(get1.body).toContain("Frozen HTML preview");
      expect(get1.body).toContain("sandbox=\"\"");
      const head = await app.inject({ method: "HEAD", url: `${path}?t=${token!.token}` });
      expect(head.statusCode).toBe(200);
      const row = await store.getTokenByHash(sha256Hex(token!.token));
      expect(row?.consumedAt).toBeNull();
      expect((await store.getIssue(tick.issueKey))?.status).toBe("pending_approval");

      const csrf = csrfForToken(env.APP_SECRET, token!.token);
      const post1 = await app.inject({
        method: "POST",
        url: path,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: `t=${token!.token}&csrf=${csrf}&action=scheduled&approverId=${token!.approverId}`,
      });
      expect(post1.statusCode).toBe(200);
      expect((await store.getIssue(tick.issueKey))?.status).toBe("queued_outbox");
      expect((await store.getTokenByHash(sha256Hex(token!.token)))?.consumedAt).toBeTruthy();

      const post2 = await app.inject({
        method: "POST",
        url: path,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: `t=${token!.token}&csrf=${csrf}&action=scheduled&approverId=${token!.approverId}`,
      });
      expect(post2.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });

  it("kill switch blocks schedule even after approval", async () => {
    const env = testEnv({ KILL_OUTBOX: "1" });
    const config = loadConfig();
    const store = new MemoryStore();
    const app = await buildApp({ env, config, store });
    try {
      const tick = await clockTick({ store, env, config, now });
      expect(tick.noOpReason).toBeUndefined();
      await ingestFixtures(store, config);
      await assembleIssue({ store, env, config, issueKey: tick.issueKey, now });
      const minted = await requestApproval({ store, env, config, issueKey: tick.issueKey });
      const token = minted.tokens![0]!;
      const path = `/approve/${issueKeyToPath(tick.issueKey)}/r/1`;
      const csrf = csrfForToken(env.APP_SECRET, token.token);
      const post1 = await app.inject({
        method: "POST",
        url: path,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: `t=${token.token}&csrf=${csrf}&action=scheduled&approverId=${token.approverId}`,
      });
      expect(post1.statusCode).toBe(423);
      expect((await store.getIssue(tick.issueKey))?.status).toBe("approved");
    } finally {
      await app.close();
    }
  });

  // Regression: the echo condition was `fixtureMode || appEnv !== "production"`.
  // docker-compose.prod.yml sets APP_ENV=staging alongside FIXTURE_MODE=true,
  // so a reachable staging host handed a live, unconsumed approval token to
  // any caller holding WORKER_TOKEN.
  it.each(["staging", "production"])(
    "never echoes raw approval tokens when APP_ENV=%s, even in fixture mode",
    async (appEnv) => {
      const env = testEnv({ APP_ENV: appEnv, FIXTURE_MODE: "true", ALLOW_TOKEN_ECHO: "1" });
      const config = loadConfig();
      const store = new MemoryStore();
      const tick = await clockTick({ store, env, config, now });
      await ingestFixtures(store, config);
      await assembleIssue({ store, env, config, issueKey: tick.issueKey, now });

      const minted = await requestApproval({ store, env, config, issueKey: tick.issueKey });

      // Tokens were still minted and persisted; they are simply not returned.
      expect(minted.issued).toBeGreaterThan(0);
      expect(minted.tokens).toBeUndefined();
      expect(JSON.stringify(minted)).not.toContain("token");
    },
  );

  it("echoes tokens in development only when explicitly opted in", async () => {
    const config = loadConfig();
    for (const [allow, expectEcho] of [
      ["1", true],
      ["0", false],
    ] as const) {
      const env = testEnv({ ALLOW_TOKEN_ECHO: allow });
      const store = new MemoryStore();
      const tick = await clockTick({ store, env, config, now });
      await ingestFixtures(store, config);
      await assembleIssue({ store, env, config, issueKey: tick.issueKey, now });
      const minted = await requestApproval({ store, env, config, issueKey: tick.issueKey });
      expect(Boolean(minted.tokens)).toBe(expectEcho);
    }
  });

  it("L1 clock no-ops", async () => {
    const env = testEnv({ KILL_SWITCH: "1" });
    const tick = await clockTick({ store: new MemoryStore(), env, config: loadConfig(), now });
    expect(tick.noOpReason).toMatch(/L1/);
  });
});
