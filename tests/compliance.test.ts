import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { fixtureSummarize } from "../src/llm/summarize";
import { brandCompletenessProblems, runQa } from "../src/qa/gates";
import { CONTENT_SCHEMA_VERSION, type BrandConfig, type ContentItem } from "../src/types";
import { withCompleteBrand } from "./support/config";

const post: ContentItem = {
  schemaVersion: CONTENT_SCHEMA_VERSION,
  id: "post:1",
  kind: "post",
  sourceId: "cms",
  canonicalUrl: "https://cdn.example.com/blog/one",
  title: "Identity reviews",
  excerpt: "A walkthrough of identity reviews for SaaS admins across the tenant.",
  publishedAt: "2026-08-19T00:00:00.000Z",
  cveIds: [],
  rawHash: "a".repeat(64),
};

const threat: ContentItem = {
  schemaVersion: CONTENT_SCHEMA_VERSION,
  id: "threat:CVE-2026-11111",
  kind: "threat",
  sourceId: "kev",
  canonicalUrl: "https://www.cisa.gov/known-exploited-vulnerabilities-catalog?search=CVE-2026-11111",
  title: "VPN RCE",
  excerpt: "Unauthenticated RCE on a VPN appliance listed in the fixture catalog.",
  publishedAt: "2026-08-18T00:00:00.000Z",
  cveIds: ["CVE-2026-11111"],
  rawHash: "b".repeat(64),
};

function qaFor(brand: BrandConfig, requireCompleteBrand: boolean) {
  const config = loadConfig();
  const llm = fixtureSummarize([post], [threat]);
  const html = `<html><body><a href="${post.canonicalUrl}">ok</a><a href="${threat.canonicalUrl}">t</a><a href="${brand.unsubscribeUrl}">Unsubscribe</a></body></html>`;
  const text = "plain text part that is long enough to count as a semantic plaintext alternative for the issue.";
  return runQa({
    llm,
    html,
    text,
    posts: [post],
    threats: [threat],
    brand,
    relevance: config.relevance,
    archiveUrl: "http://localhost:8787/archive/x/r/1",
    requireCompleteBrand,
  });
}

describe("brand completeness", () => {
  // The shipped example config is the exact thing this gate exists to catch:
  // before it, the pipeline froze and offered for approval an email whose
  // unsubscribe link was https://TODO.example.invalid/unsubscribe.
  it("flags the shipped placeholder brand config", () => {
    const problems = brandCompletenessProblems(loadConfig().brand);
    expect(problems.length).toBeGreaterThan(0);
    const joined = problems.join("\n");
    expect(joined).toMatch(/legalName/);
    expect(joined).toMatch(/postalAddress/);
    expect(joined).toMatch(/unsubscribeUrl/);
  });

  it("passes a brand with real values", () => {
    expect(brandCompletenessProblems(withCompleteBrand().brand)).toEqual([]);
  });

  it.each([
    ["TODO marker", { legalName: "TODO: legal / trade name" }],
    ["reserved example.invalid host", { siteUrl: "https://TODO.example.invalid" }],
    ["scaffolding phrase", { fromName: "replace-with-a-real-sender" }],
    ["empty required field", { postalAddress: "   " }],
  ])("rejects %s", (_label, patch) => {
    const brand = { ...withCompleteBrand().brand, ...patch } as BrandConfig;
    expect(brandCompletenessProblems(brand).length).toBeGreaterThan(0);
  });

  it("allows an empty advertisement notice", () => {
    // CAN-SPAM only requires ad identification when the primary purpose is
    // commercial, so blank is a legitimate editorial choice — unlike a TODO.
    const brand = { ...withCompleteBrand().brand, advertisementNotice: "" } as BrandConfig;
    expect(brandCompletenessProblems(brand)).toEqual([]);
  });
});

describe("compliance gate in QA", () => {
  it("warns in development but fails outside it", () => {
    const placeholder = loadConfig().brand;

    const dev = qaFor(placeholder, false);
    expect(dev.ok).toBe(true);
    expect(dev.warnings.some((w) => w.includes("placeholder"))).toBe(true);

    const deployed = qaFor(placeholder, true);
    expect(deployed.ok).toBe(false);
    expect(deployed.failures.some((f) => f.includes("placeholder"))).toBe(true);
  });

  it("passes outside development once the brand is real", () => {
    expect(qaFor(withCompleteBrand().brand, true).ok).toBe(true);
  });
});
