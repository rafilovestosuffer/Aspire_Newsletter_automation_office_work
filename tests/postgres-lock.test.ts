import { describe, expect, it } from "vitest";
import type pg from "pg";
import { PostgresStore } from "../src/store/postgres";
import { advisoryLockSql } from "../src/domain/lock";

describe("PostgresStore lock client vs pool", () => {
  it("runs getIssue on the lock-holding client, not pool.query", async () => {
    const clientQueries: string[] = [];
    let poolQueries = 0;
    const client = {
      query: async (sql: string) => {
        clientQueries.push(String(sql));
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    };
    const pool = {
      connect: async () => client,
      query: async (sql: string) => {
        poolQueries += 1;
        void sql;
        return { rows: [], rowCount: 0 };
      },
    };

    const store = new PostgresStore(pool as unknown as pg.Pool);
    await store.getIssue("outside-lock");
    expect(poolQueries).toBe(1);

    poolQueries = 0;
    await store.withIssueLock("aspire-test-lock", async () => {
      await store.getIssue("aspire-test-lock");
    });

    expect(poolQueries).toBe(0);
    expect(clientQueries.some((s) => s.includes("BEGIN"))).toBe(true);
    expect(clientQueries.some((s) => s.includes("COMMIT"))).toBe(true);
    expect(clientQueries.some((s) => s === advisoryLockSql())).toBe(true);
    expect(clientQueries.some((s) => s.includes("SELECT * FROM issues"))).toBe(true);
  });
});
