import { describe, expect, it } from "vitest";
import { CONTENT_SCHEMA_VERSION, type ContentItem } from "../src/types";
import { parseKevJson } from "../src/ingest/kev";
import { parseRssPosts } from "../src/ingest/rss";
import { selectContent } from "../src/select/score";
import { fixtureSummarize } from "../src/llm/summarize";
import { runQa } from "../src/qa/gates";
import { loadConfig } from "../src/config";
import { withCompleteBrand } from "./support/config";

const NOW = new Date("2026-08-20T12:00:00.000Z");

// ---------------------------------------------------------------------------
// B2: dueDate / requiredAction parsed from the KEV feed
// ---------------------------------------------------------------------------
describe("KEV ingest carries the remediation deadline", () => {
  const raw = JSON.stringify({
    vulnerabilities: [
      {
        cveID: "CVE-2026-99999",
        vendorProject: "Acme",
        product: "Gateway",
        vulnerabilityName: "Acme Gateway RCE",
        shortDescription: "Unauthenticated RCE in Acme Gateway.",
        dateAdded: "2026-08-15",
        dueDate: "2026-09-01",
        requiredAction: "Apply the vendor patch.",
        knownRansomwareCampaignUse: "Known",
      },
    ],
  });

  it("parses dueDate and requiredAction, previously dropped on the floor", () => {
    const [item] = parseKevJson(raw, "cisa-kev");
    expect(item?.dueDate).toBe("2026-09-01");
    expect(item?.requiredAction).toBe("Apply the vendor patch.");
    expect(item?.knownRansomware).toBe(true);
  });

  it("tolerates a missing dueDate rather than throwing", () => {
    const noDate = JSON.parse(raw);
    delete noDate.vulnerabilities[0].dueDate;
    const [item] = parseKevJson(JSON.stringify(noDate), "cisa-kev");
    expect(item?.dueDate).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// B1: third content kind — the mislabelling flaw
// ---------------------------------------------------------------------------
describe("parseRssPosts kind parameter", () => {
  const xml = `<?xml version="1.0"?><rss><channel><item>
    <title>Third-party piece</title>
    <link>https://industry.example.com/piece</link>
    <description>Some industry commentary.</description>
    <pubDate>Wed, 19 Aug 2026 00:00:00 GMT</pubDate>
  </item></channel></rss>`;

  it("defaults to post when the caller does not specify a kind", () => {
    const [item] = parseRssPosts(xml, "cms");
    expect(item?.kind).toBe("post");
  });

  it("tags a third-party feed as brief when the caller says so", () => {
    // This is the exact fix for the mislabelling bug: previously kind was
    // hard-coded to "post" regardless of caller, so a configured industry
    // feed would have been rendered as one of Aspire's own articles.
    const [item] = parseRssPosts(xml, "industry-feed", "brief");
    expect(item?.kind).toBe("brief");
    expect(item?.id.startsWith("brief:")).toBe(true);
  });

  it("gives brief and post items distinct id namespaces even from the same URL", () => {
    const [asPost] = parseRssPosts(xml, "cms", "post");
    const [asBrief] = parseRssPosts(xml, "industry-feed", "brief");
    expect(asPost!.id).not.toBe(asBrief!.id);
  });
});

// ---------------------------------------------------------------------------
// B4: urgency-first threat ordering
// ---------------------------------------------------------------------------
function threatItem(patch: Partial<ContentItem> & { id?: string }): ContentItem {
  const rawId = patch.id ?? "x";
  return {
    schemaVersion: CONTENT_SCHEMA_VERSION,
    kind: "threat",
    sourceId: "cisa-kev",
    canonicalUrl: "https://www.cisa.gov/known-exploited-vulnerabilities-catalog?search=x",
    title: "Test vuln",
    excerpt: "",
    publishedAt: "2026-08-18T00:00:00.000Z",
    cveIds: ["CVE-2026-00001"],
    rawHash: "a".repeat(64),
    ...patch,
    id: `${patch.kind ?? "threat"}:${rawId}`,
  };
}

describe("threat selection is urgency-first", () => {
  it("puts a ransomware-linked item ahead of a higher-scoring routine one", () => {
    const config = loadConfig();
    const routine = threatItem({ id: "routine", knownRansomware: false, dueDate: "2026-08-20" });
    const ransomware = threatItem({ id: "ransomware", knownRansomware: true, dueDate: "2026-09-30" });
    const { threats } = selectContent([routine, ransomware], NOW, config.relevance);
    expect(threats[0]?.id).toBe("threat:ransomware");
  });

  it("within the same ransomware tier, sorts by nearest due date", () => {
    const config = loadConfig();
    const soon = threatItem({ id: "soon", knownRansomware: false, dueDate: "2026-08-22" });
    const later = threatItem({ id: "later", knownRansomware: false, dueDate: "2026-09-30" });
    const { threats } = selectContent([later, soon], NOW, config.relevance);
    expect(threats.map((t) => t.id)).toEqual(["threat:soon", "threat:later"]);
  });

  it("selects the configured briefCap slice for the brief kind", () => {
    const config = loadConfig();
    const briefs = Array.from({ length: 5 }, (_, i) =>
      threatItem({
        id: `b${i}`,
        kind: "brief" as const,
        publishedAt: "2026-08-19T00:00:00.000Z",
      }),
    );
    const { briefs: selected } = selectContent(briefs, NOW, config.relevance);
    expect(selected.length).toBeLessThanOrEqual(config.relevance.briefCap);
    expect(selected.every((b) => b.kind === "brief")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B3: no two threat lines in a multi-item issue are identical
// ---------------------------------------------------------------------------
describe("deterministic threat copy no longer repeats verbatim", () => {
  it("gives each of several threats in one issue a distinct whyItMatters line", () => {
    const items = Array.from({ length: 6 }, (_, i) =>
      threatItem({
        id: `v${i}`,
        title: `Vuln ${i}`,
        excerpt: "", // force the framing pool, not the catalogue description
        cveIds: [`CVE-2026-0000${i}`],
        knownRansomware: i % 2 === 0,
        vendorProduct: `Vendor${i} Product${i}`,
      }),
    );
    const out = fixtureSummarize([], items);
    const lines = out.threats.map((t) => t.whyItMatters);
    expect(new Set(lines).size).toBe(lines.length);
  });

  it("is still fully deterministic for a given input", () => {
    const item = threatItem({ id: "stable", excerpt: "", knownRansomware: true });
    const a = fixtureSummarize([], [item]).threats[0]?.whyItMatters;
    const b = fixtureSummarize([], [item]).threats[0]?.whyItMatters;
    expect(a).toBe(b);
  });

  it("prefers the catalogue's own short description when it says something", () => {
    const item = threatItem({ id: "real", excerpt: "A specific, real vendor advisory summary." });
    const out = fixtureSummarize([], [item]);
    expect(out.threats[0]?.whyItMatters).toContain("A specific, real vendor advisory summary.");
  });

  it("appends a due-date note distinct from the base sentence", () => {
    const soon = threatItem({ id: "soon", excerpt: "", dueDate: new Date(NOW.getTime() + 2 * 86_400_000).toISOString().slice(0, 10) });
    const out = fixtureSummarize([], [soon]);
    expect(out.threats[0]?.whyItMatters).toMatch(/day/i);
  });
});

// ---------------------------------------------------------------------------
// B1 continued: QA refuses to let a brief masquerade as an Aspire article,
// and vice versa.
// ---------------------------------------------------------------------------
describe("QA enforces the post/brief boundary", () => {
  const brief: ContentItem = {
    schemaVersion: CONTENT_SCHEMA_VERSION,
    id: "brief:1",
    kind: "brief",
    sourceId: "industry-feed",
    canonicalUrl: "https://industry.example.com/piece",
    title: "Third-party piece",
    excerpt: "Some industry commentary long enough to be a real excerpt.",
    publishedAt: "2026-08-19T00:00:00.000Z",
    cveIds: [],
    rawHash: "b".repeat(64),
  };
  const config = withCompleteBrand();

  function baseQa(overrides: { posts?: unknown[]; briefs?: unknown[] }) {
    const llm = fixtureSummarize([], []);
    return runQa({
      llm: { ...llm, posts: (overrides.posts as never) ?? [], briefs: (overrides.briefs as never) ?? [] },
      html: `<html><body><a href="${brief.canonicalUrl}">l</a><a href="${config.brand.unsubscribeUrl}">Unsubscribe</a></body></html>`,
      text: "A plaintext alternative long enough to satisfy the semantic plaintext gate for this issue.",
      posts: [],
      threats: [],
      briefs: [brief],
      brand: config.brand,
      relevance: { ...config.relevance, allowThreatOnly: true, allowPostsOnly: true },
      archiveUrl: "http://localhost:8787/archive/x/r/1",
      requireCompleteBrand: true,
    });
  }

  it("fails QA if a brief is presented under the posts key", () => {
    const report = baseQa({ posts: [{ id: brief.id, summary: "s", ctaLabel: "Read" }] });
    expect(report.ok).toBe(false);
    expect(report.failures.some((f) => f.includes("third-party brief"))).toBe(true);
  });

  it("passes when the same item is correctly presented under the briefs key", () => {
    const report = baseQa({ briefs: [{ id: brief.id, summary: "A neutral summary of the piece." }] });
    expect(report.ok).toBe(true);
  });
});


// ---------------------------------------------------------------------------
// Promo block href allow-listing (found by running the real demo pipeline:
// the CTA URL was rejected as an unlisted href until this was added).
// ---------------------------------------------------------------------------
describe("promo block CTA is allow-listed", () => {
  it("accepts the promo ctaUrl as a legitimate href, not a QA failure", () => {
    const config = withCompleteBrand();
    const brand = {
      ...config.brand,
      promo: {
        heading: "Talk to us",
        body: "We can help with this.",
        ctaLabel: "Learn more",
        ctaUrl: "https://aspire.test/managed-security",
      },
    };
    const llm = fixtureSummarize([], []);
    const html = `<html><body><a href="${brand.unsubscribeUrl}">Unsubscribe</a><a href="${brand.promo.ctaUrl}">Learn more</a></body></html>`;
    const report = runQa({
      llm,
      html,
      text: "A plaintext alternative long enough to satisfy the semantic plaintext gate for this issue.",
      posts: [],
      threats: [],
      briefs: [],
      brand,
      relevance: { ...config.relevance, allowThreatOnly: true, allowPostsOnly: true },
      archiveUrl: "http://localhost:8787/archive/x/r/1",
      requireCompleteBrand: true,
    });
    expect(report.failures.some((f) => f.includes("promo") || f.includes(brand.promo.ctaUrl))).toBe(false);
    expect(report.failures.filter((f) => f.includes("href not on ingest/config allow-list"))).toHaveLength(0);
  });
});
