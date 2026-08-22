/**
 * Generates a demo issue through the REAL assemble pipeline — not hand-built
 * HTML — so "this is what the system produces" is a true statement.
 *
 * Content sources:
 *   - fixtures/demo/kev.json    real CISA KEV entries, snapshotted from the
 *                                live catalogue (see git history for the fetch)
 *   - fixtures/demo/posts.rss   plausible SAMPLE Aspire article titles
 *   - fixtures/demo/briefs.rss  two REAL, dated, attributed industry articles
 *
 * Legal brand fields (name, address) are deliberately left as TODO markers
 * and shown as warnings, not filled with invented facts.
 */
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, artifactsRoot, configRoot } from "../src/config";
import { loadEnv } from "../src/env";
import { assembleFromItems } from "../src/assemble/pipeline";
import { parseRssPosts } from "../src/ingest/rss";
import { parseKevJson } from "../src/ingest/kev";
import { buildIssueKey, parseIssueKey } from "../src/domain/issueKey";
import { ISSUE_SCHEMA_VERSION } from "../src/types";
import type { BrandConfig } from "../src/types";

const now = new Date("2026-08-21T13:00:00.000Z");
const root = configRoot();
const outDir = join(root, "docs", "demo");
mkdirSync(outDir, { recursive: true });

const items = [
  ...parseRssPosts(readFileSync(join(root, "fixtures/demo/posts.rss"), "utf8"), "aspiretss.com-blog"),
  ...parseKevJson(readFileSync(join(root, "fixtures/demo/kev.json"), "utf8"), "cisa-kev"),
  ...parseRssPosts(readFileSync(join(root, "fixtures/demo/briefs.rss"), "utf8"), "eSecurity Planet", "brief"),
];

// Promo copy grounded in Aspire's own publicly stated service lines (SOCaaS,
// 24/7 monitoring, vCISO) — never invented, but still marketing voice, so it
// is not held to the same factual bar as the security content above it.
const promo = {
  heading: "Need this patched, not just flagged?",
  body:
    "Aspire's 24/7 SOC is already watching for exactly this kind of exploited vulnerability across client networks. If your team is stretched thin this week, our vCISO and managed security services can take the patch board above off your plate.",
  ctaLabel: "Talk to the SOC",
  ctaUrl: "https://aspiretss.com/managed-service/socaas-services",
};

function brandVariant(theme: "light" | "dark"): BrandConfig {
  const base: BrandConfig = {
    schemaVersion: "1.0.0",
    slug: "aspire",
    displayName: "Aspire",
    // Found on Aspire's own site (aspiretss.com footer) during research for
    // this demo. NOT confirmed as the correct sending entity — flagged in
    // docs/plan/newsletter-strategy-and-plan.html section 14 as a decision
    // that needs a named owner before any real send.
    legalName: "TODO: confirm sending entity — aspiretss.com footer lists \"Aspire Tech Services & Solutions Limited\"",
    postalAddress: "TODO: valid physical postal address (CAN-SPAM) — not yet confirmed",
    fromName: "Aspire Weekly",
    fromEmail: "newsletter@aspiretss.com",
    replyTo: "hello@aspiretss.com",
    primaryColor: "#1f4e9c",
    backgroundColor: theme === "light" ? "#ffffff" : "#0f1420",
    textColor: theme === "light" ? "#12181f" : "#f0f2f5",
    logoUrl: "https://aspiretss.com/logo.png",
    siteUrl: "https://aspiretss.com",
    archiveBaseUrl: "https://aspiretss.com/newsletter/archive",
    unsubscribeUrl: "https://aspiretss.com/newsletter/unsubscribe",
    preferenceUrl: "https://aspiretss.com/newsletter/preferences",
    ghlUnsubscribeMergeTag: "{{unsubscribe_link}}",
    advertisementNotice: "",
    cdnHost: "aspiretss.com",
    promo,
  };
  return base;
}

async function buildVariant(theme: "light" | "dark") {
  const config = loadConfig();
  const brand = brandVariant(theme);
  const issueKey = buildIssueKey(brand.slug, config.schedule.audienceTimeZone, now);
  const parsed = parseIssueKey(issueKey);
  const env = loadEnv();

  const result = await assembleFromItems({
    issue: {
      schemaVersion: ISSUE_SCHEMA_VERSION,
      issueKey,
      brandSlug: parsed.brandSlug,
      audienceTz: parsed.audienceTz,
      isoWeek: parsed.isoWeek,
      revision: 1,
      status: "collecting",
    },
    items,
    config: {
      ...config,
      brand,
      // Demo-only widening of the lookback window. The live catalogue had no
      // ransomware-flagged entry inside the real 8-day production window this
      // week — that is normal, not every week has one — but the demo should
      // show the ransomware-marker path, so it reaches back far enough to
      // include one real (not invented) ransomware-linked CVE. Production
      // keeps the configured 8-day window; only this demo script widens it.
      relevance: { ...config.relevance, postLookbackDays: 60 },
    },
    now,
    artifactsRoot: artifactsRoot(env.ARTIFACT_DIR),
    publicBaseUrl: "https://aspiretss.com",
    llmProvider: "fixture",
    llmApiKey: "",
    // Demo intentionally does NOT set requireCompleteBrand: true — the
    // unfilled legal fields must render as warnings, visible in the demo,
    // never silently pass compliance.
  });

  const htmlPath = join(outDir, `aspire-weekly-demo-${theme}.html`);
  writeFileSync(htmlPath, result.html);
  writeFileSync(join(outDir, `aspire-weekly-demo-${theme}.txt`), result.text);
  return { theme, htmlPath, qa: result.qa, htmlBytes: Buffer.byteLength(result.html, "utf8"), issue: result.issue };
}

async function main() {
  const results = await Promise.all([buildVariant("light"), buildVariant("dark")]);
  for (const r of results) {
    console.log(
      `${r.theme}: qa.ok=${r.qa.ok} bytes=${r.htmlBytes} subject=${JSON.stringify(r.issue.subject)} -> ${r.htmlPath}`,
    );
    if (r.qa.failures.length) console.log("  FAILURES:", r.qa.failures);
  }
  writeFileSync(join(outDir, "demo-manifest.json"), JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
