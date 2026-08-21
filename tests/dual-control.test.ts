import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { loadEnv } from "../src/env";
import { csrfForToken } from "../src/domain/hash";
import {
  assembleIssue,
  clockTick,
  consumeApproval,
  ingestFixtures,
  requestApproval,
} from "../src/services/control";
import { MemoryStore } from "../src/store/memory";

const now = new Date("2026-08-20T19:00:00.000Z");

describe("dual-control approvals", () => {
  it("one POST stays pending_approval when two approvers are required", async () => {
    const env = loadEnv({
      APP_ENV: "development",
      DRY_RUN: "true",
      FIXTURE_MODE: "true",
      ALLOW_TOKEN_ECHO: "1",
      APP_SECRET: "test-secret-at-least-32-bytes-long",
      WORKER_TOKEN: "test-worker",
      PUBLIC_BASE_URL: "http://localhost:8787",
    });
    const config = loadConfig();
    config.approvers.requireTwoApprovers = true;
    const store = new MemoryStore();
    const tick = await clockTick({ store, env, config, now });
    await ingestFixtures(store, config);
    await assembleIssue({ store, env, config, issueKey: tick.issueKey, now });
    const minted = await requestApproval({ store, env, config, issueKey: tick.issueKey });
    expect(minted.tokens?.length).toBeGreaterThanOrEqual(2);
    const first = minted.tokens![0]!;
    const second = minted.tokens![1]!;

    const one = await consumeApproval({
      store,
      env,
      config,
      rawToken: first.token,
      csrf: csrfForToken(env.APP_SECRET, first.token),
      action: "scheduled",
      comment: "",
      approverId: first.approverId,
    });
    expect(one.issueStatus).toBe("pending_approval");
    expect((await store.getIssue(tick.issueKey))?.status).toBe("pending_approval");

    const two = await consumeApproval({
      store,
      env,
      config,
      rawToken: second.token,
      csrf: csrfForToken(env.APP_SECRET, second.token),
      action: "scheduled",
      comment: "",
      approverId: second.approverId,
    });
    expect(two.issueStatus).toBe("queued_outbox");
  });
});
