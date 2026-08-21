import Fastify from "fastify";
import formbody from "@fastify/formbody";
import type { Env } from "./env";
import type { AppConfig } from "./types";
import type { IssueStore } from "./store/types";
import { registerHealth } from "./routes/health";
import { registerApproval } from "./routes/approval";
import { registerInternal } from "./routes/internal";

export async function buildApp(opts: { env: Env; config: AppConfig; store: IssueStore }) {
  const underVitest = Boolean(process.env.VITEST);
  const level = (opts.env.LOG_LEVEL || "info").toLowerCase();
  const loggerOff = underVitest || level === "silent" || level === "off" || level === "false";
  const app = Fastify({
    logger: loggerOff ? false : { level: opts.env.LOG_LEVEL || "info" },
    exposeHeadRoutes: false,
    trustProxy: true,
  });
  await app.register(formbody);
  await registerHealth(app, opts);
  await registerApproval(app, opts);
  await registerInternal(app, opts);
  return app;
}
