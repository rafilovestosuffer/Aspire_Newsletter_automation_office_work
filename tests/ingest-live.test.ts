import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { ingestLive, isPlaceholderHost } from "../src/services/ingest-live";
import { MemoryStore } from "../src/store/memory";

describe("live ingest allowlist + placeholders", () => {
  it("treats TODO.example.invalid as a placeholder host", () => {
    expect(isPlaceholderHost("TODO.example.invalid")).toBe(true);
    expect(isPlaceholderHost("todo-threat-feed.example.invalid")).toBe(true);
    expect(isPlaceholderHost("www.cisa.gov")).toBe(false);
  });

  it("never fetches placeholder CMS URLs", async () => {
    const fetched: string[] = [];
    const store = new MemoryStore();
    const result = await ingestLive(store, loadConfig(), {
      fetchImpl: async (input) => {
        fetched.push(String(input));
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    expect(result.skipped).toContain("cms");
    expect(fetched.some((u) => u.toLowerCase().includes("example.invalid"))).toBe(false);
    expect(fetched.some((u) => u.toLowerCase().includes("todo.example"))).toBe(false);
  });
});
