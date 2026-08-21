import type { FastifyInstance } from "fastify";
import type { Env } from "../env";
import type { AppConfig } from "../types";
import type { IssueStore } from "../store/types";
import { issueKeyFromPath } from "../domain/issueKey";
import { envKill, mergeKill } from "../domain/policy";
import {
  assembleIssue,
  clockTick,
  drainOutbox,
  ingestContent,
  requestApproval,
} from "../services/control";
import { workerAuthorized } from "./approval";

export async function registerInternal(
  app: FastifyInstance,
  ctx: { env: Env; store: IssueStore; config: AppConfig },
) {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith("/internal/")) return;
    if (!workerAuthorized(req, ctx.env)) {
      return reply.status(401).send({ error: "unauthorized" });
    }
  });

  app.post<{ Body: { now?: string } }>("/internal/clock/tick", async (req) => {
    const now = req.body?.now ? new Date(req.body.now) : new Date();
    return clockTick({ store: ctx.store, env: ctx.env, config: ctx.config, now });
  });

  app.post<{ Params: { issueKeyPath: string } }>("/internal/issues/:issueKeyPath/collect", async (req) => {
    const issueKey = issueKeyFromPath(req.params.issueKeyPath);
    return clockTick({
      store: ctx.store,
      env: ctx.env,
      config: ctx.config,
      now: new Date(),
    }).then(async (tick) => {
      if (tick.issueKey && tick.issueKey !== issueKey) {
        return { ...tick, requested: issueKey };
      }
      return tick.issueKey ? tick : { issueKey, status: tick.status, noOpReason: tick.noOpReason };
    });
  });

  app.post<{ Body: { fixture?: boolean } }>("/internal/issues/:issueKeyPath/ingest-posts", async (req) =>
    ingestContent({
      store: ctx.store,
      env: ctx.env,
      config: ctx.config,
      scope: "posts",
      forceFixture: req.body?.fixture,
    }),
  );

  app.post<{ Body: { fixture?: boolean } }>("/internal/issues/:issueKeyPath/ingest-threats", async (req) =>
    ingestContent({
      store: ctx.store,
      env: ctx.env,
      config: ctx.config,
      scope: "threats",
      forceFixture: req.body?.fixture,
    }),
  );

  app.post<{ Params: { issueKeyPath: string }; Body: { now?: string } }>(
    "/internal/issues/:issueKeyPath/assemble",
    async (req) => {
      const issueKey = issueKeyFromPath(req.params.issueKeyPath);
      const now = req.body?.now ? new Date(req.body.now) : new Date();
      return assembleIssue({
        store: ctx.store,
        env: ctx.env,
        config: ctx.config,
        issueKey,
        now,
      });
    },
  );

  app.post<{ Params: { issueKeyPath: string } }>(
    "/internal/issues/:issueKeyPath/request-approval",
    async (req) => {
      const issueKey = issueKeyFromPath(req.params.issueKeyPath);
      return requestApproval({ store: ctx.store, env: ctx.env, config: ctx.config, issueKey });
    },
  );

  app.post<{ Body: { limit?: number } }>("/internal/outbox/drain", async (req) => {
    return drainOutbox({
      store: ctx.store,
      env: ctx.env,
      config: ctx.config,
      limit: req.body?.limit ?? 10,
    });
  });

  app.post("/internal/observe", async () => {
    return { updated: 0, note: "DRY_RUN observe: no live GHL stats" };
  });

  app.post("/internal/watchdog", async () => {
    return { escalated: 0, note: "never auto-sends" };
  });

  app.post("/internal/reconcile", async () => {
    const inflight = await ctx.store.listInFlight();
    return { mismatches: 0, inflight: inflight.length };
  });

  app.post<{ Body: { level: "L1" | "L2"; enabled: boolean; reason: string } }>("/internal/kill", async (req) => {
    await ctx.store.setKill(req.body.level, req.body.enabled, req.body.reason);
    const kill = mergeKill(envKill(ctx.env.KILL_SWITCH, ctx.env.KILL_OUTBOX), await ctx.store.getKill());
    return { killL1: kill.l1, killL2: kill.l2 };
  });
}
