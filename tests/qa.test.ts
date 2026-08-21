import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { fixtureSummarize } from "../src/llm/summarize";
import { runQa } from "../src/qa/gates";
import { CONTENT_SCHEMA_VERSION, type ContentItem } from "../src/types";

const post: ContentItem = {
  schemaVersion: CONTENT_SCHEMA_VERSION,
  id: "post:1",
  kind: "post",
  sourceId: "cms",
  canonicalUrl: "https://TODO.example.invalid/blog/one",
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

describe("QA gates", () => {
  it("fails extra href from LLM/HTML", () => {
    const config = loadConfig();
    const llm = fixtureSummarize([post], [threat]);
    const html = `<html><body><a href="${post.canonicalUrl}">ok</a><a href="https://evil.example/phish">x</a><a href="${config.brand.unsubscribeUrl}">Unsubscribe</a></body></html>`;
    const text = "plain text part that is long enough to count as a semantic plaintext alternative for the issue.";
    const qa = runQa({
      llm,
      html,
      text,
      posts: [post],
      threats: [threat],
      brand: config.brand,
      relevance: config.relevance,
      archiveUrl: "http://localhost:8787/archive/x/r/1",
    });
    expect(qa.ok).toBe(false);
    expect(qa.failures.some((f) => f.includes("evil.example"))).toBe(true);
  });

  // Regression: MJML compile errors were pushed into qa.warnings, so a
  // template that failed to render still passed QA, froze, and became
  // eligible for approval and broadcast.
  it("fails when the MJML template did not render cleanly", () => {
    const config = loadConfig();
    const llm = fixtureSummarize([post], [threat]);
    const html = `<html><body><a href="${post.canonicalUrl}">ok</a><a href="${threat.canonicalUrl}">t</a><a href="${config.brand.unsubscribeUrl}">Unsubscribe</a></body></html>`;
    const text = "plain text part that is long enough to count as a semantic plaintext alternative for the issue.";
    const args = {
      llm,
      html,
      text,
      posts: [post],
      threats: [threat],
      brand: config.brand,
      relevance: config.relevance,
      archiveUrl: "http://localhost:8787/archive/x/r/1",
    };

    // Same inputs, no render errors: passes.
    expect(runQa(args).ok).toBe(true);

    // With a render error: must fail, not merely warn.
    const withError = runQa({ ...args, renderErrors: ["mj-column must be inside mj-section"] });
    expect(withError.ok).toBe(false);
    expect(withError.failures.some((f) => f.includes("MJML render error"))).toBe(true);
    expect(withError.warnings.some((w) => w.includes("mj-column"))).toBe(false);
  });

  it("fails CVE not in ingested source", () => {
    const config = loadConfig();
    const llm = fixtureSummarize([post], [threat]);
    llm.editorBlurb += " Also see CVE-2099-99999 which we invented.";
    const html = `<html><body><a href="${post.canonicalUrl}">ok</a><a href="${threat.canonicalUrl}">t</a><a href="${config.brand.unsubscribeUrl}">Unsubscribe</a><p>${llm.editorBlurb}</p></body></html>`;
    const text = `${llm.editorBlurb} Also see CVE-2099-99999 which we invented. plaintext padding for length.`;
    const qa = runQa({
      llm,
      html,
      text,
      posts: [post],
      threats: [threat],
      brand: config.brand,
      relevance: config.relevance,
      archiveUrl: "http://localhost:8787/archive/x/r/1",
    });
    expect(qa.ok).toBe(false);
    expect(qa.failures.some((f) => f.includes("CVE-2099-99999"))).toBe(true);
  });
});
