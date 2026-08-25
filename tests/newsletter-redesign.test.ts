import { describe, expect, it } from "vitest";
import { CONTENT_SCHEMA_VERSION, type ContentItem } from "../src/types";
import { parseKevJson } from "../src/ingest/kev";
import { parseRssPosts } from "../src/ingest/rss";
import { selectContent } from "../src/select/score";
import { fixtureSummarize } from "../src/llm/summarize";
import { extractImageSrcs, runQa } from "../src/qa/gates";
import { compileMjml, compilePlaintext } from "../src/render/compile";
import { resolveTheme, severityColor, urgencyBucket } from "../src/render/theme";
import { embedEmail, scopeCss } from "../scripts/lib/embed-email.mjs";
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
    const out = fixtureSummarize([], [soon], [], NOW);
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


// ---------------------------------------------------------------------------
// Design system: severity / urgency colour, brand-hosted images, and the
// `src` gate that has to exist before any image may be rendered at all.
// ---------------------------------------------------------------------------
describe("design tokens resolve from brand config", () => {
  it("falls back to the shipped palette when a brand supplies no tokens", () => {
    const theme = resolveTheme(withCompleteBrand().brand);
    expect(theme.muted).toBe("#6B7885");
    expect(theme.card).toBe("#F7F9FB");
    expect(severityColor(theme, "critical")).toBe("#B03A3A");
  });

  it("prefers a brand's own severity colour over the default", () => {
    const brand = { ...withCompleteBrand().brand, severityColors: { critical: "#123456" } };
    expect(severityColor(resolveTheme(brand), "critical")).toBe("#123456");
  });

  it("gives an unrecognised severity a real colour rather than an empty fill", () => {
    // `severity` is LLM-supplied and not enum-pinned, so this must not be "".
    const theme = resolveTheme(withCompleteBrand().brand);
    expect(severityColor(theme, "catastrophic")).toBe(theme.severityFallback);
    expect(severityColor(theme, "catastrophic")).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it("buckets a KEV deadline by how much time the reader actually has", () => {
    const at = (days: number) =>
      urgencyBucket(new Date(NOW.getTime() + days * 86_400_000).toISOString().slice(0, 10), NOW.getTime());
    expect(at(-5)).toBe("overdue");
    expect(at(2)).toBe("soon");
    expect(at(30)).toBe("ok");
    // No due date means no pill at all, rather than a misleading neutral one.
    expect(urgencyBucket(undefined, NOW.getTime())).toBeUndefined();
    expect(urgencyBucket("not-a-date", NOW.getTime())).toBeUndefined();
  });
});

describe("rendered HTML carries the visual signal, not an emoji", () => {
  const config = withCompleteBrand();
  function render(threats: ContentItem[], brand = config.brand) {
    const llm = fixtureSummarize([], threats, [], NOW);
    return compileMjml({
      brand,
      issueLabel: "2026-W34 · r1",
      archiveUrl: "https://aspire.test/archive/x",
      llm,
      posts: [],
      threats,
      briefs: [],
      now: NOW,
    });
  }

  it("marks a ransomware-linked item with a text pill and no astral-plane codepoint", () => {
    const { html } = render([threatItem({ id: "r", knownRansomware: true })]);
    expect(html).toContain("RANSOMWARE");
    // The previous "🔴 RANSOMWARE" had no glyph in the fonts the print
    // pipeline embeds and printed as a missing-glyph box.
    expect([...html].some((ch) => (ch.codePointAt(0) ?? 0) > 0xffff)).toBe(false);
  });

  it("colours the card by severity and the deadline by urgency", () => {
    const overdue = threatItem({
      id: "o",
      knownRansomware: true,
      dueDate: new Date(NOW.getTime() - 4 * 86_400_000).toISOString().slice(0, 10),
    });
    const { html } = render([overdue]);
    const theme = resolveTheme(config.brand);
    // fixtureSummarize marks a ransomware item "critical". The stripe is now a
    // rule beside the numeral rather than a border around a card.
    expect(html).toContain(`border-left:3px solid ${theme.severity.critical}`);
    expect(html).toContain(theme.urgency.overdue);
    expect(html).toContain("Due date passed");
  });

  it("omits the deadline pill entirely when the item has no due date", () => {
    const { html } = render([threatItem({ id: "n" })]);
    expect(html).not.toContain("Due in");
    expect(html).not.toContain("Due date passed");
  });

  it("renders a brand's raster logo when it supplies one", () => {
    const { html, errors } = render([threatItem({ id: "l" })]);
    expect(errors).toEqual([]);
    expect(html).toContain(config.brand.logoUrl);
    expect(html).toContain("<img");
  });

  it("falls back to a live-text wordmark when the brand has no logo", () => {
    // Text beats an image here: many corporate clients block images by
    // default, and an image would need a second asset for dark mode.
    const { html } = render([threatItem({ id: "w" })], { ...config.brand, logoUrl: "" });
    expect(html).toContain("WEEKLY");
    expect(html).not.toContain("<img");
  });

  it("renders a hero image only when the brand supplies one", () => {
    const without = render([threatItem({ id: "h" })]).html;
    expect(without).not.toContain("/hero.png");
    const withHero = render([threatItem({ id: "h" })], {
      ...config.brand,
      heroImageUrl: "https://cdn.aspire.test/hero.png",
    }).html;
    expect(withHero).toContain("https://cdn.aspire.test/hero.png");
  });

  it("drops the reading-time label when the excerpt is too short to estimate from", () => {
    // Five cards all claiming "1 min read" is boilerplate, not information.
    const post: ContentItem = {
      schemaVersion: CONTENT_SCHEMA_VERSION,
      id: "post:short",
      kind: "post",
      sourceId: "cms",
      canonicalUrl: "https://aspire.test/blog/one",
      title: "A post",
      excerpt: "A short teaser.",
      publishedAt: "2026-08-19T00:00:00.000Z",
      cveIds: [],
      rawHash: "c".repeat(64),
    };
    const llm = fixtureSummarize([post], [], [], NOW);
    const { html } = compileMjml({
      brand: config.brand,
      issueLabel: "2026-W34 · r1",
      archiveUrl: "https://aspire.test/archive/x",
      llm,
      posts: [post],
      threats: [],
      briefs: [],
      now: NOW,
    });
    expect(html).not.toContain("min read");

    const long = { ...post, excerpt: "word ".repeat(400) };
    const longHtml = compileMjml({
      brand: config.brand,
      issueLabel: "2026-W34 · r1",
      archiveUrl: "https://aspire.test/archive/x",
      llm: fixtureSummarize([long], [], [], NOW),
      posts: [long],
      threats: [],
      briefs: [],
      now: NOW,
    }).html;
    expect(longHtml).toContain("min read");
  });

  it("is deterministic for a pinned clock, because the output is hashed and frozen", () => {
    const a = render([threatItem({ id: "d", dueDate: "2026-09-01" })]).html;
    const b = render([threatItem({ id: "d", dueDate: "2026-09-01" })]).html;
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// The `src` gate. An href is a link the reader chooses to follow; a `src` is
// fetched the moment the message is opened. Before this existed, adding one
// image to the template would have opened an un-inspected egress channel.
// ---------------------------------------------------------------------------
describe("QA gates image sources as strictly as hrefs", () => {
  const config = withCompleteBrand();

  function qaWithImage(src: string, brand = config.brand) {
    const llm = fixtureSummarize([], [], [], NOW);
    return runQa({
      llm,
      html: `<html><body><img src="${src}"><a href="${brand.unsubscribeUrl}">Unsubscribe</a></body></html>`,
      text: "A plaintext alternative long enough to satisfy the semantic plaintext gate for this issue.",
      posts: [],
      threats: [],
      briefs: [],
      brand,
      relevance: { ...config.relevance, allowThreatOnly: true, allowPostsOnly: true },
      archiveUrl: "https://aspire.test/archive/x/r/1",
      requireCompleteBrand: true,
    });
  }
  const imageFailures = (r: { failures: string[] }) => r.failures.filter((f) => f.includes("image src"));

  it("finds a src and a CSS url(), not just an href", () => {
    const found = extractImageSrcs(
      `<img src="https://a.test/1.png"><td background="x" style="background:url('https://b.test/2.png')">`,
    );
    expect(found).toContain("https://a.test/1.png");
    expect(found).toContain("https://b.test/2.png");
  });

  it("does not mistake a different attribute ending in -src for a src", () => {
    expect(extractImageSrcs(`<img data-src="https://a.test/lazy.png" src="https://b.test/real.png">`)).toEqual([
      "https://b.test/real.png",
    ]);
  });

  it("accepts the brand logo", () => {
    expect(imageFailures(qaWithImage(config.brand.logoUrl))).toHaveLength(0);
  });

  it("accepts any asset on the brand's own CDN host", () => {
    expect(imageFailures(qaWithImage("https://cdn.aspire.test/newsletter/icon.png"))).toHaveLength(0);
  });

  it("accepts a configured hero image and section icon", () => {
    const brand = {
      ...config.brand,
      heroImageUrl: "https://assets.elsewhere.test/hero.png",
      sectionIcons: { threats: "https://assets.elsewhere.test/threats.png" },
    };
    expect(imageFailures(qaWithImage(brand.heroImageUrl, brand))).toHaveLength(0);
    expect(imageFailures(qaWithImage(brand.sectionIcons.threats, brand))).toHaveLength(0);
  });

  it("fails a third-party image host — the tracking-pixel case", () => {
    const report = qaWithImage("https://tracker.evil.test/open.gif");
    expect(report.ok).toBe(false);
    expect(imageFailures(report).length).toBeGreaterThan(0);
  });

  it("fails a host that merely looks like the CDN", () => {
    expect(imageFailures(qaWithImage("https://cdn.aspire.test.evil.test/logo.png")).length).toBeGreaterThan(0);
  });

  it("fails a data: image, which would carry its own payload past the allow-list", () => {
    expect(imageFailures(qaWithImage("data:image/gif;base64,R0lGODlhAQABAAAAACw=")).length).toBeGreaterThan(0);
  });

  it("fails a cleartext http: image", () => {
    expect(imageFailures(qaWithImage("http://cdn.aspire.test/logo.png")).length).toBeGreaterThan(0);
  });

  it("leaves ESP merge tokens alone", () => {
    expect(imageFailures(qaWithImage("{{tracking_pixel}}"))).toHaveLength(0);
  });

  it("passes the real rendered issue, logo and all", () => {
    const threats = [threatItem({ id: "t", knownRansomware: true, dueDate: "2026-09-01" })];
    const llm = fixtureSummarize([], threats, [], NOW);
    const { html } = compileMjml({
      brand: config.brand,
      issueLabel: "2026-W34 · r1",
      archiveUrl: "https://aspire.test/archive/x/r/1",
      llm,
      posts: [],
      threats,
      briefs: [],
      now: NOW,
    });
    const report = runQa({
      llm,
      html,
      text: "A plaintext alternative long enough to satisfy the semantic plaintext gate for this issue.",
      posts: [],
      threats,
      briefs: [],
      brand: config.brand,
      relevance: { ...config.relevance, allowThreatOnly: true, allowPostsOnly: true },
      archiveUrl: "https://aspire.test/archive/x/r/1",
      requireCompleteBrand: true,
    });
    expect(report.failures).toEqual([]);
    // The redesign added card markup; the Gmail clip budget still has to hold.
    expect(Buffer.byteLength(html, "utf8")).toBeLessThan(config.relevance.gmailWarnBytes);
  });
});


// ---------------------------------------------------------------------------
// Embedding the email in the review PDF.
//
// Both of these were found by rendering the document and looking at it, not by
// reading the code: the page came out with the email's dark background and the
// appendix heading was nearly invisible on it.
// ---------------------------------------------------------------------------
describe("an email document is isolated before being embedded in a page", () => {
  const emailDoc = [
    "<!doctype html><html><head>",
    "<style>body{margin:0}table,td{border-collapse:collapse}",
    "@media (prefers-color-scheme: dark){.dm-bg{background-color:#14181f !important}}</style>",
    '</head><body style="background-color:#0f1420;word-spacing:normal">',
    '<table><tr><td class="dm-bg">hello</td></tr></table>',
    "</body></html>",
  ].join("");

  it("takes the body background off the body tag so it cannot repaint the host page", () => {
    // The HTML parser merges a second <body> tag's attributes onto the real
    // one, so leaving it inline turned the whole review document dark.
    const { bodyStyle, content } = embedEmail(emailDoc);
    expect(bodyStyle).toContain("#0f1420");
    expect(content).not.toMatch(/<body/i);
    expect(content).not.toMatch(/<\/?html/i);
    expect(content).not.toMatch(/<!doctype/i);
    expect(content).toContain("hello");
  });

  it("scopes every rule of the email's stylesheet, including inside @media", () => {
    const { css } = embedEmail(emailDoc, ".frame");
    // `body` becomes the frame itself — inside the frame, the frame is the body.
    expect(css).toContain(".frame{margin:0}");
    expect(css).toContain(".frame table,.frame td{");
    expect(css).toContain("@media (prefers-color-scheme: dark){.frame .dm-bg{");
    // Nothing may be left that can match outside the frame.
    expect(css).not.toMatch(/(^|\n|\{)\s*(body|table|td|\.dm-bg)\s*[,{]/);
  });

  it("does not read a comma inside a comment as a selector separator", () => {
    // A comment swallowing the prelude boundary left the rule after it
    // unscoped, so .dm-bg and .pill escaped the frame entirely.
    const css = scopeCss("/* colour carries meaning, not decoration */\n.pill{color:#fff}", ".frame");
    expect(css).toContain(".frame .pill{");
    expect(css).not.toContain("decoration");
    expect(css).not.toMatch(/(^|\n)\.pill\{/);
  });

  it("leaves at-rules that carry no selectors alone", () => {
    const css = scopeCss('@font-face{font-family:"X";src:url(x.woff2)}a{color:red}', ".frame");
    expect(css).toContain('@font-face{font-family:"X";src:url(x.woff2)}');
    expect(css).toContain(".frame a{color:red}");
  });

  it("passes a bare fragment through untouched", () => {
    const { content, css, bodyStyle } = embedEmail("<div>just a fragment</div>");
    expect(content).toBe("<div>just a fragment</div>");
    expect(css).toBe("");
    expect(bodyStyle).toBe("");
  });

  it("isolates the real rendered issue, both directions", () => {
    const config = withCompleteBrand();
    const threats = [threatItem({ id: "t", knownRansomware: true, dueDate: "2026-09-01" })];
    const { html } = compileMjml({
      brand: config.brand,
      issueLabel: "2026-W34 · r1",
      archiveUrl: "https://aspire.test/archive/x",
      llm: fixtureSummarize([], threats, [], NOW),
      posts: [],
      threats,
      briefs: [],
      now: NOW,
    });
    const { css, content, bodyStyle } = embedEmail(html, ".frame");
    expect(content).not.toMatch(/<body/i);
    expect(bodyStyle).toContain(config.brand.backgroundColor);
    // MJML's own resets must not be able to reach the review chrome.
    for (const line of css.split("\n").map((l) => l.trim()).filter(Boolean)) {
      // At-rule preludes carry no selector; a bare brace closes a group.
      if (line.startsWith("@") || line === "}" || line === "{") continue;
      expect(line.startsWith(".frame")).toBe(true);
    }
  });
});


// ---------------------------------------------------------------------------
// The editorial redesign. Each of these pins one of three complaints about the
// previous draft: left-aligned buttons, no contents block, and every story
// rendered through one identical box.
// ---------------------------------------------------------------------------
describe("editorial layout", () => {
  const config = withCompleteBrand();

  function issue(counts: { threats: number; briefs: number; posts: number }) {
    const threats = Array.from({ length: counts.threats }, (_, i) =>
      threatItem({
        id: `t${i}`,
        title: `Threat ${i}`,
        cveIds: [`CVE-2026-1000${i}`],
        knownRansomware: i === 0,
        dueDate: i === 1 ? "2026-08-01" : "2026-09-30",
      }),
    );
    const mk = (kind: "post" | "brief", i: number): ContentItem => ({
      schemaVersion: CONTENT_SCHEMA_VERSION,
      id: `${kind}:${i}`,
      kind,
      sourceId: kind === "post" ? "cms" : "industry-feed",
      canonicalUrl: `https://${kind === "post" ? "aspire.test/blog" : "industry.example.com"}/${i}`,
      title: `${kind === "post" ? "Post" : "Brief"} ${i}`,
      excerpt: "An excerpt long enough to read as a real one for these purposes.",
      publishedAt: "2026-08-19T00:00:00.000Z",
      cveIds: [],
      rawHash: `${kind[0]}`.repeat(64).slice(0, 64),
    });
    const posts = Array.from({ length: counts.posts }, (_, i) => mk("post", i));
    const briefs = Array.from({ length: counts.briefs }, (_, i) => mk("brief", i));
    const llm = fixtureSummarize(posts, threats, briefs, NOW);
    const { html, errors } = compileMjml({
      brand: config.brand,
      issueLabel: "2026-W34 · r1",
      archiveUrl: "https://aspire.test/archive/x",
      llm,
      posts,
      threats,
      briefs,
      now: NOW,
    });
    const text = compilePlaintext({
      brand: config.brand,
      issueLabel: "2026-W34 · r1",
      archiveUrl: "https://aspire.test/archive/x",
      llm,
      posts,
      threats,
      briefs,
      now: NOW,
    });
    return { html, text, errors, threats, posts, briefs };
  }

  it("renders cleanly", () => {
    expect(issue({ threats: 4, briefs: 2, posts: 5 }).errors).toEqual([]);
  });

  it("centres the primary CTA", () => {
    const { html } = issue({ threats: 2, briefs: 0, posts: 1 });
    // Centre is the default for a primary action; left is for a secondary
    // in-line one. Every CTA in the previous draft was left-aligned.
    expect(html).toMatch(/<table[^>]*align="center"[^>]*>[\s\S]{0,400}?Read the advisory/);
    expect(html).not.toMatch(/align="left"[^>]{0,200}Read the advisory/);
  });

  it("gives the CTA a tap target at least 44px tall", () => {
    const { html } = issue({ threats: 1, briefs: 0, posts: 0 });
    // 14px padding top and bottom around a 14px/normal line ≈ 46px.
    expect(html).toContain("padding:14px 30px");
  });

  describe("in this issue", () => {
    it("counts what is actually in the issue", () => {
      const { html } = issue({ threats: 4, briefs: 2, posts: 5 });
      expect(html).toContain("In this issue");
      expect(html).toContain("4 KEV items");
      expect(html).toContain("1 ransomware-linked");
      expect(html).toContain("1 past its federal deadline");
      expect(html).toContain("2 attributed briefs");
    });

    it("moves with the content rather than being written by hand", () => {
      const { html } = issue({ threats: 1, briefs: 1, posts: 1 });
      // Scoped to the contents block: the section heading below it says
      // "This week's KEV items" regardless of how many there are.
      const start = html.indexOf("In this issue");
      const contents = html.slice(start, html.indexOf("</table>", start));
      expect(contents).toContain("1 KEV item");
      expect(contents).not.toContain("KEV items");
      expect(contents).toContain("1 attributed brief");
      expect(contents).not.toContain("attributed briefs");
    });

    it("links each line to a real destination, never an in-email anchor", () => {
      // Anchor links do nothing in the Gmail mobile apps or Outlook for Mac,
      // which is most opens — so contents entries link to the source instead.
      const { html, threats } = issue({ threats: 2, briefs: 1, posts: 1 });
      const start = html.indexOf("In this issue");
      const contents = html.slice(start, html.indexOf("</table>", start));
      expect(contents).toContain(threats[0]!.canonicalUrl);
      expect(html).not.toMatch(/href="#/);
    });

    it("names the lead blog post so the reader knows what is inside", () => {
      const { html } = issue({ threats: 1, briefs: 0, posts: 3 });
      expect(html).toContain("Post 0");
    });

    it("disappears entirely for an empty issue", () => {
      const { html } = issue({ threats: 0, briefs: 0, posts: 0 });
      expect(html).not.toContain("In this issue");
    });

    it("is mirrored into the plaintext part", () => {
      const { text } = issue({ threats: 4, briefs: 2, posts: 5 });
      expect(text).toContain("IN THIS ISSUE");
      expect(text).toContain("4 KEV items");
      expect(text).toContain("2 attributed briefs");
    });
  });

  describe("rank", () => {
    it("sets the lead threat larger than the ones below it", () => {
      // The previous draft had one gear: nine identically sized boxes. The
      // lead has to look like the lead.
      const { html } = issue({ threats: 3, briefs: 0, posts: 0 });
      expect(html).toContain("font-size:23px");
      expect(html).toContain("font-size:18px");
      expect(html.match(/font-size:23px/g) ?? []).toHaveLength(1);
    });

    it("gives only the lead threat a button", () => {
      const { html } = issue({ threats: 3, briefs: 0, posts: 0 });
      expect(html.match(/Read the advisory/g) ?? []).toHaveLength(3);
      expect(html.match(/padding:14px 30px/g) ?? []).toHaveLength(1);
    });

    it("numbers the stories", () => {
      const { html } = issue({ threats: 3, briefs: 0, posts: 2 });
      for (const n of ["01", "02", "03"]) expect(html).toContain(n);
    });
  });

  it("separates stories with a rule instead of boxing each one", () => {
    const { html } = issue({ threats: 3, briefs: 0, posts: 0 });
    const theme = resolveTheme(config.brand);
    // A rule between stories, and none above the first.
    expect(html.match(new RegExp(`border-top:1px solid ${theme.border}`, "g")) ?? []).toHaveLength(2);
  });

  it("keeps the issue inside the Gmail byte budget", () => {
    // The card layout hit 97KB against a 102KB clip once mj-group markup was
    // counted. Editorial rows are a table, and cheaper.
    const { html } = issue({ threats: 7, briefs: 3, posts: 5 });
    expect(Buffer.byteLength(html, "utf8")).toBeLessThan(config.relevance.gmailWarnBytes);
  });
});
