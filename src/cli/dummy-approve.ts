import { buildApp } from "../app";
import { loadConfig } from "../config";
import { loadEnv } from "../env";
import { MemoryStore } from "../store/memory";
import { assembleIssue, clockTick, ingestFixtures, requestApproval } from "../services/control";
import { issueKeyToPath } from "../domain/issueKey";
import { csrfForToken, sha256Hex } from "../domain/hash";

const now = new Date("2026-08-20T19:00:00.000Z");

async function main() {
  const env = loadEnv({
    ...process.env,
    APP_ENV: "development",
    DRY_RUN: "true",
    FIXTURE_MODE: "true",
    APP_SECRET: process.env.APP_SECRET || "dev-only-not-for-production-use-32b",
    WORKER_TOKEN: process.env.WORKER_TOKEN || "dev-worker-token",
    LOG_LEVEL: process.env.LOG_LEVEL || "silent",
  });
  const config = loadConfig();
  const store = new MemoryStore();
  const app = await buildApp({ env, config, store });
  try {
    const tick = await clockTick({ store, env, config, now });
    await ingestFixtures(store, config);
    const assembled = await assembleIssue({ store, env, config, issueKey: tick.issueKey, now });
    if (assembled.status !== "assembled") {
      throw new Error(`assemble failed: ${JSON.stringify(assembled)}`);
    }
    const req = await requestApproval({ store, env, config, issueKey: tick.issueKey });
    const token = req.tokens?.[0];
    if (!token) throw new Error("no token");
    const path = `/approve/${issueKeyToPath(tick.issueKey)}/r/${assembled.revision}`;

    const get1 = await app.inject({ method: "GET", url: `${path}?t=${token.token}` });
    const head = await app.inject({ method: "HEAD", url: `${path}?t=${token.token}` });
    const still = await store.getTokenByHash(sha256Hex(token.token));
    const consumedAfterGet = still?.consumedAt;
    if (consumedAfterGet) throw new Error("GET/HEAD consumed token");

    const csrf = csrfForToken(env.APP_SECRET, token.token);
    const post1 = await app.inject({
      method: "POST",
      url: path,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `t=${token.token}&csrf=${csrf}&action=scheduled&approverId=${token.approverId}`,
    });
    const post2 = await app.inject({
      method: "POST",
      url: path,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `t=${token.token}&csrf=${csrf}&action=scheduled&approverId=${token.approverId}`,
    });

    const report = {
      issueKey: tick.issueKey,
      getStatus: get1.statusCode,
      headStatus: head.statusCode,
      getConsumed: Boolean(consumedAfterGet),
      post1: post1.statusCode,
      post2: post2.statusCode,
      after: (await store.getIssue(tick.issueKey))?.status,
      sent: false,
    };
    console.log(JSON.stringify(report, null, 2));
    if (get1.statusCode !== 200 || head.statusCode !== 200 || consumedAfterGet || post1.statusCode !== 200 || post2.statusCode !== 409) {
      process.exit(1);
    }
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
