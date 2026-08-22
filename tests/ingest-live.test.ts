import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { ingestLive, isPlaceholderHost } from "../src/services/ingest-live";
import { loadFixtureItems } from "../src/services/control";
import { MemoryStore } from "../src/store/memory";

function recordingFetch(sink: string[]): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    sink.push(String(input));
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("live ingest allowlist + placeholders", () => {
  it("treats TODO.example.invalid as a placeholder host", () => {
    expect(isPlaceholderHost("TODO.example.invalid")).toBe(true);
    expect(isPlaceholderHost("todo-threat-feed.example.invalid")).toBe(true);
    expect(isPlaceholderHost("www.cisa.gov")).toBe(false);
  });

  it("never fetches placeholder CMS URLs", async () => {
    const fetched: string[] = [];
    const result = await ingestLive(new MemoryStore(), loadConfig(), { fetchImpl: recordingFetch(fetched) });
    expect(result.skipped).toContain("cms");
    expect(fetched.some((u) => u.toLowerCase().includes("example.invalid"))).toBe(false);
    expect(fetched.some((u) => u.toLowerCase().includes("todo.example"))).toBe(false);
  });
});

describe("ingest scope keeps posts and threats workers distinct", () => {
  it("scope=posts touches only the CMS feed", async () => {
    const fetched: string[] = [];
    const result = await ingestLive(new MemoryStore(), loadConfig(), {
      fetchImpl: recordingFetch(fetched),
      scope: "posts",
    });
    expect(result.scope).toBe("posts");
    expect(result.skipped).toContain("cms");
    // Threat feeds must not be considered at all under a posts-only run.
    expect(result.skipped).not.toContain("extra-rss");
    expect(fetched.some((u) => u.includes("cisa.gov"))).toBe(false);
  });

  it("scope=threats touches only the threat feeds", async () => {
    const fetched: string[] = [];
    const result = await ingestLive(new MemoryStore(), loadConfig(), {
      fetchImpl: recordingFetch(fetched),
      scope: "threats",
    });
    expect(result.scope).toBe("threats");
    expect(result.skipped).not.toContain("cms");
    expect(result.skipped).toContain("extra-rss");
    expect(fetched.some((u) => u.includes("cisa.gov"))).toBe(true);
  });

  it("fixture loading honours the same scope", () => {
    const config = loadConfig();
    const posts = loadFixtureItems(config, "posts");
    const threats = loadFixtureItems(config, "threats");
    const all = loadFixtureItems(config, "all");

    expect(posts.length).toBeGreaterThan(0);
    expect(threats.length).toBeGreaterThan(0);
    expect(posts.every((i) => i.kind === "post")).toBe(true);
    expect(threats.every((i) => i.kind === "threat")).toBe(true);
    // "all" now also covers the third slice (industry briefs); the fixture
    // registers two of them.
    expect(all.length).toBe(posts.length + threats.length + 2);
    expect(all.filter((i) => i.kind === "brief")).toHaveLength(2);
  });
});
