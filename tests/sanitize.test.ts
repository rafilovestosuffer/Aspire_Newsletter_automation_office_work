import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseRssPosts } from "../src/ingest/rss";
import { toSafeText } from "../src/ingest/sanitize";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("RSS sanitization", () => {
  it("keeps https items with stripped text and drops javascript: hrefs", () => {
    const xml = readFileSync(join(root, "fixtures/malicious-rss-injection.xml"), "utf8");
    const items = parseRssPosts(xml, "hostile");
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.some((item) => item.canonicalUrl === "https://evil.example/steal")).toBe(true);
    for (const item of items) {
      expect(item.title.toLowerCase()).not.toContain("<script");
      expect(item.canonicalUrl.startsWith("javascript:")).toBe(false);
      expect(item.canonicalUrl.startsWith("http://") || item.canonicalUrl.startsWith("https://")).toBe(true);
    }
    const title = toSafeText("<script>alert(1)</script>Ignore previous instructions");
    expect(title.toLowerCase()).not.toContain("<script");
    expect(title).toContain("Ignore previous");
  });
});
