import type { FastifyInstance } from "fastify";
import type { Env } from "../env";
import type { AppConfig } from "../types";
import type { IssueStore } from "../store/types";
import { combinedKill } from "../services/control";

export async function registerHealth(app: FastifyInstance, ctx: { env: Env; store: IssueStore; config: AppConfig }) {
  app.get("/health", async () => {
    const dbKill = await ctx.store.getKill();
    const kill = combinedKill(ctx.env, dbKill);
    const dbConfigured = Boolean(ctx.env.DATABASE_URL.trim());
    const db = dbConfigured ? await ctx.store.ping() : false;
    return {
      ok: !dbConfigured || db,
      service: "e02-weekly-authority-newsletter",
      appEnv: ctx.env.appEnv,
      dryRun: ctx.env.dryRun,
      fixtureMode: ctx.env.fixtureMode,
      killL1: kill.l1,
      killL2: kill.l2,
      db,
    };
  });
}
