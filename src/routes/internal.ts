import type { FastifyInstance } from "fastify";
import type { Env } from "../env";
import type { AppConfig } from "../types";
import type { IssueStore } from "../store/types";
import { issueKeyFromPath } from "../domain/issueKey";
import { envKill, mergeKill } from "../domain/policy";
import {
  assembleIssue,
  clockTick,
  collectIssue,
  drainOutbox,
  ingestContent,
  pruneContent,
  reconcileIssues,
  requestApproval,
  runWatchdog,
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

  app.post<{ Params: { issueKeyPath: string } }>("/internal/issues/:issueKeyPath/collect", async (req) =>
    collectIssue({
      store: ctx.store,
      env: ctx.env,
      config: ctx.config,
      issueKey: issueKeyFromPath(req.params.issueKeyPath),
    }),
  );

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

  app.post<{ Body: { fixture?: boolean } }>("/internal/issues/:issueKeyPath/ingest-briefs", async (req) =>
    ingestContent({
      store: ctx.store,
      env: ctx.env,
      config: ctx.config,
      scope: "briefs",
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

  app.post("/internal/retention/prune", async () =>
    pruneContent({ store: ctx.store, config: ctx.config, now: new Date() }),
  );

  // Stats field names are UNVERIFIED in docs/BINDING-DECISIONS.md, and the
  // repo rule is that a guessed payload is worse than no payload. This stays a
  // declared no-op until the sandbox spike reads them off a real sent campaign.
  app.post("/internal/observe", async () => {
    return {
      updated: 0,
      note: "not implemented: GHL statistics field names are UNVERIFIED until the sandbox spike",
    };
  });

  app.post<{ Body: { now?: string } }>("/internal/watchdog", async (req) => {
    const now = req.body?.now ? new Date(req.body.now) : new Date();
    return runWatchdog({ store: ctx.store, env: ctx.env, config: ctx.config, now });
  });

  app.post<{ Body: { now?: string } }>("/internal/reconcile", async (req) => {
    const now = req.body?.now ? new Date(req.body.now) : new Date();
    return reconcileIssues({ store: ctx.store, env: ctx.env, config: ctx.config, now });
  });

  app.post<{ Body: { level: "L1" | "L2"; enabled: boolean; reason: string } }>("/internal/kill", async (req) => {
    await ctx.store.setKill(req.body.level, req.body.enabled, req.body.reason);
    const kill = mergeKill(envKill(ctx.env.KILL_SWITCH, ctx.env.KILL_OUTBOX), await ctx.store.getKill());
    return { killL1: kill.l1, killL2: kill.l2 };
  });
}
