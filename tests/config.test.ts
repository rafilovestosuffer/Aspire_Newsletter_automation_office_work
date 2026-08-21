import { describe, expect, it } from "vitest";
import { loadConfig, parseMiniYaml } from "../src/config";

describe("config yaml", () => {
  it("loads example YAML with nested lists", () => {
    const cfg = loadConfig();
    expect(cfg.brand.slug).toBe("aspire");
    expect(cfg.schedule.audienceTimeZone).toBe("America/New_York");
    expect(cfg.relevance.postCap).toBe(5);
    expect(cfg.relevance.threatCap).toBe(7);
    expect(cfg.feeds.threatFeeds[0]?.id).toBe("cisa-kev");
    expect(cfg.approvers.approvers.length).toBeGreaterThanOrEqual(1);
    expect(cfg.approvers.sandboxAudience.kind).toBe("contactIds");
  });

  it("parses empty collections", () => {
    const doc = parseMiniYaml(`skipWeeks: []\nfilter: {}\n`);
    expect(doc).toEqual({ skipWeeks: [], filter: {} });
  });
});
