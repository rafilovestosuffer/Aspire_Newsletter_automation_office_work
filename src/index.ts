import { pathToFileURL } from "node:url";
import pg from "pg";
import { buildApp } from "./app";
import { loadConfig } from "./config";
import { assertSafeProductionBoot, loadEnv } from "./env";
import { MemoryStore } from "./store/memory";
import { PostgresStore } from "./store/postgres";

/** Single control-plane entry. `src/server.ts` calls this same function. */
export async function start(envSource: NodeJS.ProcessEnv = process.env): Promise<void> {
  const env = loadEnv(envSource);
  assertSafeProductionBoot(env);
  const config = loadConfig();
  const store = env.DATABASE_URL
    ? new PostgresStore(new pg.Pool({ connectionString: env.DATABASE_URL }))
    : new MemoryStore();
  if (!env.DATABASE_URL) {
    console.warn("DATABASE_URL empty: using MemoryStore (tokens/outbox die on restart; not for VPS)");
  }
  const app = await buildApp({ env, config, store });
  await app.listen({ port: env.port, host: "0.0.0.0" });
  console.log(
    `E-02 control plane on :${env.port} DRY_RUN=${env.dryRun} FIXTURE_MODE=${env.fixtureMode} db=${Boolean(env.DATABASE_URL)}`,
  );
}

export { start as main };

function isDirectEntry(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return import.meta.url === pathToFileURL(arg).href;
  } catch {
    return /[/\\]src[/\\]index\.ts$/i.test(arg);
  }
}

if (isDirectEntry()) {
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
