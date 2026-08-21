import { z } from "zod";
import type { AppEnv } from "./types";

export const DEV_APP_SECRET = "dev-only-not-for-production-use-32b";
export const DEV_WORKER_TOKEN = "dev-worker-token";

const envSchema = z.object({
  APP_ENV: z.enum(["development", "staging", "production"]).default("development"),
  DRY_RUN: z.string().default("true"),
  FIXTURE_MODE: z.string().default("true"),
  PORT: z.string().default("8787"),
  PUBLIC_BASE_URL: z.string().default("http://localhost:8787"),
  DATABASE_URL: z.string().optional().default(""),
  APP_SECRET: z.string().default(DEV_APP_SECRET),
  WORKER_TOKEN: z.string().default(DEV_WORKER_TOKEN),
  ALLOW_TOKEN_ECHO: z.string().default("0"),
  KILL_SWITCH: z.string().default("0"),
  KILL_OUTBOX: z.string().default("0"),
  DUAL_CONTROL_FIRST_N: z.string().default("4"),
  LOG_LEVEL: z.string().default("info"),
  ARTIFACT_DIR: z.string().optional().default(""),
  GHL_BASE_URL: z.string().default("https://services.leadconnectorhq.com"),
  GHL_API_VERSION: z.string().default("v3"),
  GHL_SANDBOX_LOCATION_ID: z.string().optional().default(""),
  GHL_SANDBOX_USER_ID: z.string().optional().default(""),
  GHL_SANDBOX_PIT: z.string().optional().default(""),
  GHL_PROD_LOCATION_ID: z.string().optional().default(""),
  GHL_PROD_USER_ID: z.string().optional().default(""),
  GHL_PROD_PIT: z.string().optional().default(""),
  TWENTY_API_URL: z.string().optional().default(""),
  TWENTY_API_KEY: z.string().optional().default(""),
  TWENTY_NEWSLETTER_OBJECT: z.string().optional().default("newsletterIssues"),
  LLM_PROVIDER: z.string().default("fixture"),
  LLM_API_KEY: z.string().optional().default(""),
  LLM_MODEL: z.string().optional().default(""),
  // Staff notification. Deliberately NOT LC Email: that is the subscriber
  // channel, and putting operational mail on the marketing domain risks its
  // sending reputation. Any transactional provider that speaks SMTP works.
  STAFF_NOTIFY_FROM: z.string().optional().default(""),
  STAFF_NOTIFY_TO: z.string().optional().default(""),
  STAFF_NOTIFY_SMTP_URL: z.string().optional().default(""),
  STAFF_NOTIFY_WEBHOOK: z.string().optional().default(""),
  ONCALL_WEBHOOK_URL: z.string().optional().default(""),
});

function truthy(v: string): boolean {
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

export type Env = z.infer<typeof envSchema> & {
  appEnv: AppEnv;
  dryRun: boolean;
  fixtureMode: boolean;
  /** Echo raw approval tokens in the request body. Development only. */
  allowTokenEcho: boolean;
  port: number;
  dualControlFirstN: number;
};

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.parse(source);
  return {
    ...parsed,
    appEnv: parsed.APP_ENV,
    dryRun: truthy(parsed.DRY_RUN),
    fixtureMode: truthy(parsed.FIXTURE_MODE),
    allowTokenEcho: truthy(parsed.ALLOW_TOKEN_ECHO),
    port: Number(parsed.PORT) || 8787,
    dualControlFirstN: Number(parsed.DUAL_CONTROL_FIRST_N) || 4,
  };
}

/** Refuse a production listen with default secrets or no Postgres. */
export function assertSafeProductionBoot(env: Env): void {
  if (env.appEnv !== "production") return;
  if (!env.DATABASE_URL.trim()) {
    throw new Error("DATABASE_URL is required when APP_ENV=production (MemoryStore is not SoR)");
  }
  if (env.APP_SECRET === DEV_APP_SECRET || env.APP_SECRET.length < 32) {
    throw new Error("APP_SECRET must be a unique 32+ byte secret when APP_ENV=production");
  }
  if (env.WORKER_TOKEN === DEV_WORKER_TOKEN || env.WORKER_TOKEN.length < 16) {
    throw new Error("WORKER_TOKEN must be a unique secret when APP_ENV=production");
  }
}
