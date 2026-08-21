import { describe, expect, it } from "vitest";
import { assertSafeProductionBoot, DEV_APP_SECRET, DEV_WORKER_TOKEN, loadEnv } from "../src/env";

describe("assertSafeProductionBoot", () => {
  it("allows development with defaults", () => {
    expect(() => assertSafeProductionBoot(loadEnv({ APP_ENV: "development" }))).not.toThrow();
  });

  it("refuses production without DATABASE_URL", () => {
    const env = loadEnv({
      APP_ENV: "production",
      DATABASE_URL: "",
      APP_SECRET: "unique-production-secret-32b-min",
      WORKER_TOKEN: "unique-worker-token",
    });
    expect(() => assertSafeProductionBoot(env)).toThrow(/DATABASE_URL/);
  });

  it("refuses production default APP_SECRET", () => {
    const env = loadEnv({
      APP_ENV: "production",
      DATABASE_URL: "postgres://newsletter:x@127.0.0.1:5432/newsletter",
      APP_SECRET: DEV_APP_SECRET,
      WORKER_TOKEN: "unique-worker-token",
    });
    expect(() => assertSafeProductionBoot(env)).toThrow(/APP_SECRET/);
  });

  it("refuses production default WORKER_TOKEN", () => {
    const env = loadEnv({
      APP_ENV: "production",
      DATABASE_URL: "postgres://newsletter:x@127.0.0.1:5432/newsletter",
      APP_SECRET: "unique-production-secret-32b-min",
      WORKER_TOKEN: DEV_WORKER_TOKEN,
    });
    expect(() => assertSafeProductionBoot(env)).toThrow(/WORKER_TOKEN/);
  });
});
