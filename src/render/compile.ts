import { readFileSync } from "node:fs";
import { join } from "node:path";
import mjml2html from "mjml";
import { templatesDir } from "../paths";
import type { BrandConfig, ContentItem, LlmOutput } from "../types";

const shellPath = join(templatesDir(), "brand-shell.mjml");

export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function subst(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{{${k}}}`, v);
  }
  return out;
}

function readingTime(wordCount: number): string {
  const minutes = Math.max(1, Math.round(wordCount / 200));
  return `${minutes} min read`;
}

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function dueDateLabel(dueDate?: string): string {
  if (!dueDate) return "";
  const days = Math.ceil((Date.parse(`${dueDate}T00:00:00.000Z`) - Date.now()) / 86_400_000);
  if (Number.isNaN(days)) return "";
  if (days < 0) return "Due date passed";
  if (days === 0) return "Due today";
  return `Due in ${days}d (${dueDate})`;
}

export function compileMjml(opts: {
  brand: BrandConfig;
  issueLabel: string;
  archiveUrl: string;
  llm: LlmOutput;
  posts: ContentItem[];
  threats: ContentItem[];
  briefs?: ContentItem[];
}): { html: string; errors: string[] } {
  const briefs = opts.briefs ?? [];
  const byId = new Map([...opts.posts, ...opts.threats, ...briefs].map((i) => [i.id, i]));
  const postBlocks = opts.llm.posts
    .map((p) => {
      const item = byId.get(p.id);
      const href = item?.canonicalUrl ?? "";
      const rt = readingTime(wordCount(item?.excerpt ?? p.summary));
      return `<mj-section padding="4px 16px"><mj-column>
        <mj-text font-weight="bold">${escapeHtml(item?.title ?? p.id)}</mj-text>
        <mj-text font-size="12px" color="#6b7885">${escapeHtml(rt)}</mj-text>
        <mj-text>${escapeHtml(p.summary)}</mj-text>
        <mj-button href="${escapeHtml(href)}">${escapeHtml(p.ctaLabel)}</mj-button>
      </mj-column></mj-section>`;
    })
    .join("\n");

  // Rows already arrive in urgency order from selectContent (ransomware, then
  // nearest due date); the renderer's job is to make that order visible, not
  // to re-sort it.
  const threatBlocks = opts.llm.threats
    .map((t) => {
      const item = byId.get(t.id);
      const href = item?.canonicalUrl ?? "";
      const cve = item?.cveIds[0] ?? "";
      const vp = item?.vendorProduct ?? "";
      const due = dueDateLabel(item?.dueDate);
      const ransomwareTag = item?.knownRansomware ? "🔴 RANSOMWARE" : "";
      const meta = [vp, due, ransomwareTag].filter(Boolean).map(escapeHtml).join(" · ");
      return `<mj-section padding="4px 16px"><mj-column>
        <mj-text font-weight="bold">${escapeHtml(cve)} · ${escapeHtml(t.severity)} · ${escapeHtml(item?.title ?? "")}</mj-text>
        ${meta ? `<mj-text font-size="12px" color="#6b7885">${meta}</mj-text>` : ""}
        <mj-text>${escapeHtml(t.whyItMatters)}</mj-text>
        <mj-text font-size="14px"><a href="${escapeHtml(href)}">Source</a></mj-text>
      </mj-column></mj-section>`;
    })
    .join("\n");

  const briefBlocks = opts.llm.briefs
    .map((b) => {
      const item = byId.get(b.id);
      const href = item?.canonicalUrl ?? "";
      // sourceId is the ingest feed identifier, the only honest attribution
      // available without inventing a publication name.
      const source = item?.sourceId ?? "";
      return `<mj-section padding="4px 16px"><mj-column>
        <mj-text font-weight="bold">${escapeHtml(item?.title ?? b.id)}</mj-text>
        ${source ? `<mj-text font-size="12px" color="#6b7885">via ${escapeHtml(source)}</mj-text>` : ""}
        <mj-text>${escapeHtml(b.summary)}</mj-text>
        <mj-text font-size="14px"><a href="${escapeHtml(href)}">Read more</a></mj-text>
      </mj-column></mj-section>`;
    })
    .join("\n");

  const promo = opts.brand.promo;
  const promoBlock =
    promo && promo.heading.trim()
      ? `<mj-section padding="16px 16px" border-left="4px solid ${escapeHtml(opts.brand.primaryColor)}">
          <mj-column>
            <mj-text font-size="11px" color="#6b7885" text-transform="uppercase" letter-spacing="1px">Sponsored by ${escapeHtml(opts.brand.displayName)}</mj-text>
            <mj-text font-weight="bold" font-size="17px">${escapeHtml(promo.heading)}</mj-text>
            <mj-text>${escapeHtml(promo.body)}</mj-text>
            ${promo.ctaUrl ? `<mj-button href="${escapeHtml(promo.ctaUrl)}">${escapeHtml(promo.ctaLabel || "Learn more")}</mj-button>` : ""}
          </mj-column>
        </mj-section>`
      : "";

  const briefsSection = briefBlocks
    ? `<mj-section padding="16px 16px 0"><mj-column>
        <mj-text font-size="18px" font-weight="bold">AI &amp; security this week</mj-text>
        <mj-text font-size="12px" color="#9AA8BC">Third-party coverage, summarised and attributed — not written by ${escapeHtml(opts.brand.displayName)}.</mj-text>
      </mj-column></mj-section>\n${briefBlocks}`
    : "";

  const mjml = subst(readFileSync(shellPath, "utf8"), {
    subject: escapeHtml(opts.llm.subject),
    preheader: escapeHtml(opts.llm.preheader),
    textColor: opts.brand.textColor,
    primaryColor: opts.brand.primaryColor,
    backgroundColor: opts.brand.backgroundColor,
    displayName: escapeHtml(opts.brand.displayName),
    issueLabel: escapeHtml(opts.issueLabel),
    archiveUrl: escapeHtml(opts.archiveUrl),
    editorBlurb: escapeHtml(opts.llm.editorBlurb),
    postBlocks,
    threatBlocks,
    promoBlock,
    briefsSection,
    legalName: escapeHtml(opts.brand.legalName),
    postalAddress: escapeHtml(opts.brand.postalAddress),
    advertisementNotice: escapeHtml(opts.brand.advertisementNotice),
    unsubscribeUrl: escapeHtml(opts.brand.unsubscribeUrl),
    preferenceUrl: escapeHtml(opts.brand.preferenceUrl),
    ghlUnsubscribeMergeTag: escapeHtml(opts.brand.ghlUnsubscribeMergeTag),
  });

  // `minify: false` is a security control, not a style choice.
  //
  // mjml pulls in html-minifier <=4.0.0, which carries a high-severity ReDoS
  // (GHSA-pfq8-rq6v-vf5m) and has no patched release — the fix only exists in
  // mjml 5, a semver-major that would change rendered bytes and therefore every
  // frozen artifact hash. mjml-core only calls the minifier when this flag is
  // true (mjml-core/lib/index.js: `if (minify)`), so the vulnerable path is
  // unreachable while it stays false. Feed excerpts reach this HTML, so an
  // attacker-influenced string would otherwise be the minifier's input.
  //
  // tests/qa.test.ts pins this. Do not flip it on without upgrading mjml first.
  const rendered = mjml2html(mjml, { validationLevel: "soft", minify: false }) as unknown as {
    html: string;
    errors: Array<{ formattedMessage?: string }>;
  };
  return { html: rendered.html, errors: (rendered.errors ?? []).map((e) => e.formattedMessage ?? String(e)) };
}

export function compilePlaintext(opts: {
  brand: BrandConfig;
  issueLabel: string;
  archiveUrl: string;
  llm: LlmOutput;
  posts: ContentItem[];
  threats: ContentItem[];
  briefs?: ContentItem[];
}): string {
  const briefs = opts.briefs ?? [];
  const byId = new Map([...opts.posts, ...opts.threats, ...briefs].map((i) => [i.id, i]));
  const promo = opts.brand.promo;
  const lines = [
    `${opts.brand.displayName} Weekly — ${opts.issueLabel}`,
    opts.llm.subject,
    opts.llm.preheader,
    "",
    opts.llm.editorBlurb,
    "",
    "PATCH BOARD — This week in threats",
    "Public KEV data is CC0. This is not a CISA or DHS product.",
    // Rows already arrive in urgency order from selectContent.
    ...opts.llm.threats.flatMap((t) => {
      const item = byId.get(t.id);
      const meta = [
        item?.vendorProduct,
        item?.dueDate ? `due ${item.dueDate}` : "",
        item?.knownRansomware ? "RANSOMWARE" : "",
      ].filter(Boolean).join(" · ");
      return [
        "",
        `${item?.cveIds[0] ?? ""} ${item?.title ?? ""} (${t.severity})`,
        meta,
        t.whyItMatters,
        item?.canonicalUrl ?? "",
      ].filter((l) => l !== "");
    }),
    ...(promo && promo.heading.trim()
      ? ["", `SPONSORED BY ${opts.brand.displayName.toUpperCase()}`, promo.heading, promo.body, promo.ctaUrl || ""]
      : []),
    ...(briefs.length
      ? [
          "",
          "AI & SECURITY THIS WEEK",
          `Third-party coverage, summarised and attributed — not written by ${opts.brand.displayName}.`,
          ...opts.llm.briefs.flatMap((b) => {
            const item = byId.get(b.id);
            return ["", item?.title ?? b.id, `via ${item?.sourceId ?? ""}`, b.summary, item?.canonicalUrl ?? ""];
          }),
        ]
      : []),
    "",
    "FROM THE BLOG",
    ...opts.llm.posts.flatMap((p) => {
      const item = byId.get(p.id);
      return ["", item?.title ?? p.id, p.summary, item?.canonicalUrl ?? ""];
    }),
    "",
    opts.brand.legalName,
    opts.brand.postalAddress,
    opts.brand.advertisementNotice,
    `Unsubscribe: ${opts.brand.unsubscribeUrl}`,
    `Preferences: ${opts.brand.preferenceUrl}`,
    `Archive: ${opts.archiveUrl}`,
  ];
  return lines.join("\n");
}
