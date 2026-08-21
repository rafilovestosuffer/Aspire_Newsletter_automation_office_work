import { describe, expect, it } from "vitest";
import pg from "pg";
import { loadConfig } from "../src/config";
import { migrate } from "../src/db/migrate";
import { PostgresStore } from "../src/store/postgres";
import { uuidV4 } from "../src/domain/hash";
import { ISSUE_SCHEMA_VERSION } from "../src/types";
import { loadEnv } from "../src/env";
import {
  RETENTION_WINDOW_MULTIPLE,
  assembleIssue,
  clockTick,
  ingestFixtures,
  pruneContent,
} from "../src/services/control";
import { MemoryStore } from "../src/store/memory";
import { CONTENT_SCHEMA_VERSION, type ContentItem } from "../src/types";

const now = new Date("2026-08-20T19:00:00.000Z");

function item(id: string, daysAgo: number): ContentItem {
  return {
    schemaVersion: CONTENT_SCHEMA_VERSION,
    id,
    kind: "post",
    sourceId: "cms",
    canonicalUrl: `https://cdn.example.com/blog/${id}`,
    title: `Post ${id}`,
    excerpt: "An excerpt long enough to be meaningful for selection tests.",
    publishedAt: new Date(now.getTime() - daysAgo * 86_400_000).toISOString(),
    cveIds: [],
    rawHash: "c".repeat(64),
  };
}

function testEnv() {
  return loadEnv({
    APP_ENV: "development",
    DRY_RUN: "true",
    FIXTURE_MODE: "true",
    ALLOW_TOKEN_ECHO: "1",
    APP_SECRET: "test-secret-at-least-32-bytes-long",
    WORKER_TOKEN: "test-worker",
    PUBLIC_BASE_URL: "http://localhost:8787",
  });
}

describe("content window", () => {
  it("listContentSince returns only items at or after the cutoff", async () => {
    const store = new MemoryStore();
    for (const [id, days] of [["fresh", 1], ["edge", 5], ["stale", 40]] as const) {
      await store.upsertContent(item(id, days));
    }
    const cutoff = new Date(now.getTime() - 8 * 86_400_000);
    const ids = (await store.listContentSince(cutoff)).map((i) => i.id).sort();

    expect(ids).toEqual(["edge", "fresh"]);
    expect(await store.listContent()).toHaveLength(3);
  });

  // Regression: assemble read every content item ever ingested and filtered in
  // memory, so the query cost grew without bound as content_items accumulated.
  it("assemble queries the window, never the whole table", async () => {
    const env = testEnv();
    const config = loadConfig();
    const calls: string[] = [];

    class SpyStore extends MemoryStore {
      override async listContent() {
        calls.push("listContent");
        return super.listContent();
      }
      override async listContentSince(cutoff: Date) {
        calls.push("listContentSince");
        expect(now.getTime() - cutoff.getTime()).toBe(config.relevance.postLookbackDays * 86_400_000);
        return super.listContentSince(cutoff);
      }
    }

    const store = new SpyStore();
    const tick = await clockTick({ store, env, config, now });
    await ingestFixtures(store, config);
    const assembled = await assembleIssue({ store, env, config, issueKey: tick.issueKey, now });

    expect(assembled.status).toBe("assembled");
    expect(calls).toContain("listContentSince");
    expect(calls).not.toContain("listContent");
  });
});

describe("content retention", () => {
  it("prunes old unreferenced content and keeps anything an issue cites", async () => {
    const store = new MemoryStore();
    const config = loadConfig();
    const retentionDays = config.relevance.postLookbackDays * RETENTION_WINDOW_MULTIPLE;

    await store.upsertContent(item("recent", 1));
    await store.upsertContent(item("old-orphan", retentionDays + 10));
    await store.upsertContent(item("old-but-cited", retentionDays + 10));

    // A sent issue still cites this item; it must survive so the issue stays
    // reproducible from its sources.
    await store.setIssueItems("issue-1", [
      { contentItemId: "old-but-cited", role: "post", sortOrder: 0 },
    ]);

    const result = await pruneContent({ store, config, now });

    expect(result.removed).toBe(1);
    expect(result.retentionDays).toBe(retentionDays);
    const remaining = (await store.listContent()).map((i) => i.id).sort();
    expect(remaining).toEqual(["old-but-cited", "recent"]);
  });

  it("prune is a no-op when everything is inside the retention window", async () => {
    const store = new MemoryStore();
    await store.upsertContent(item("a", 1));
    await store.upsertContent(item("b", 3));
    const result = await pruneContent({ store, config: loadConfig(), now });
    expect(result.removed).toBe(0);
    expect(await store.listContent()).toHaveLength(2);
  });
});

const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";

// The window query and the retention DELETE are SQL, so MemoryStore parity
// proves nothing about them. Self-gates like tests/postgres-e2e.test.ts.
describe.skipIf(!databaseUrl)("content window + retention on Postgres", () => {
  it("windows by published_at and refuses to delete cited rows", async () => {
    await migrate(databaseUrl);
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const store = new PostgresStore(pool);
    const tag = `ret${Date.now()}`;
    const config = loadConfig();
    const retentionDays = config.relevance.postLookbackDays * RETENTION_WINDOW_MULTIPLE;

    try {
      const fresh = { ...item(`${tag}-fresh`, 1) };
      const orphan = { ...item(`${tag}-orphan`, retentionDays + 10) };
      const cited = { ...item(`${tag}-cited`, retentionDays + 10) };
      for (const i of [fresh, orphan, cited]) await store.upsertContent(i);

      // Window query must exclude both stale rows.
      const cutoff = new Date(now.getTime() - config.relevance.postLookbackDays * 86_400_000);
      const windowed = (await store.listContentSince(cutoff)).map((i) => i.id);
      expect(windowed).toContain(fresh.id);
      expect(windowed).not.toContain(orphan.id);
      expect(windowed).not.toContain(cited.id);

      // Cite one stale row from a real issue.
      const issueId = uuidV4();
      await store.insertIssue({
        schemaVersion: ISSUE_SCHEMA_VERSION,
        id: issueId,
        issueKey: `${tag}-America/New_York-2026-W34`,
        brandSlug: tag,
        audienceTz: "America/New_York",
        isoWeek: "2026-W34",
        revision: 1,
        status: "sent",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await store.setIssueItems(issueId, [
        { contentItemId: cited.id, role: "post", sortOrder: 0 },
      ]);

      const before = new Date(now.getTime() - retentionDays * 86_400_000);
      const removed = await store.pruneContent(before);

      // Exactly the orphan goes. issue_items.content_item_id is a FK with no
      // ON DELETE CASCADE, so without the NOT EXISTS guard this statement
      // would raise a foreign-key violation rather than skip the cited row.
      expect(removed).toBeGreaterThanOrEqual(1);
      const ids = (await store.listContent()).map((i) => i.id);
      expect(ids).toContain(cited.id);
      expect(ids).toContain(fresh.id);
      expect(ids).not.toContain(orphan.id);
    } finally {
      await pool.end();
    }
  });
});
