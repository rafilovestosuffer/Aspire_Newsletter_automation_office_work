import { readFileSync } from "node:fs";
import { join } from "node:path";
import mjml2html from "mjml";
import { templatesDir } from "../paths";
import type { BrandConfig, ContentItem, LlmOutput } from "../types";
import { resolveTheme, severityColor, urgencyBucket, type Theme } from "./theme";

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

/**
 * Minimum excerpt length before a reading-time estimate says anything.
 *
 * The estimate divides an excerpt's word count by 200, so a short RSS teaser
 * always produces "1 min read". Five cards all claiming "1 min read" is worse
 * than no label: it reads as boilerplate and tells the reader nothing. Below
 * this threshold the label is omitted entirely.
 */
const READING_TIME_MIN_WORDS = 120;

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/** Returns "" when the source text is too short for the estimate to mean anything. */
function readingTime(source: string): string {
  const words = wordCount(source);
  if (words < READING_TIME_MIN_WORDS) return "";
  return `${Math.max(1, Math.round(words / 200))} min read`;
}

function dueDateLabel(dueDate: string | undefined, now: number): string {
  if (!dueDate) return "";
  const days = Math.ceil((Date.parse(`${dueDate}T00:00:00.000Z`) - now) / 86_400_000);
  if (Number.isNaN(days)) return "";
  if (days < 0) return "Due date passed";
  if (days === 0) return "Due today";
  return `Due in ${days}d (${dueDate})`;
}

/**
 * A solid-fill label. Colour is the whole point of these — severity and a
 * federal remediation deadline are what a security reader scans for, and in
 * the previous design both were plain grey text in a `·`-joined run.
 *
 * `label` is escaped here; `fill` is a config-supplied colour, never feed text.
 */
function pill(label: string, fill: string): string {
  return `<span class="pill" style="background-color:${fill};border-radius:3px;padding:2px 7px;color:#ffffff;font-weight:bold;white-space:nowrap;">${escapeHtml(
    label,
  )}</span>`;
}

/** Card chrome shared by threat, brief and post blocks. */
function card(theme: Theme, accent: string, inner: string): string {
  return `<mj-section padding="8px 16px" css-class="dm-bg"><mj-column background-color="${theme.card}" border="1px solid ${theme.border}" border-left="4px solid ${accent}" padding="14px 16px" css-class="dm-card">
${inner}
      </mj-column></mj-section>`;
}

/** An image block, or "" when the brand has not supplied that asset. */
function imageBlock(url: string | undefined, alt: string, width: string, padding: string): string {
  const trimmed = (url ?? "").trim();
  if (!trimmed) return "";
  return `<mj-image src="${escapeHtml(trimmed)}" alt="${escapeHtml(alt)}" width="${width}" align="left" padding="${padding}" />`;
}

export function compileMjml(opts: {
  brand: BrandConfig;
  issueLabel: string;
  archiveUrl: string;
  llm: LlmOutput;
  posts: ContentItem[];
  threats: ContentItem[];
  briefs?: ContentItem[];
  /**
   * Clock for deadline wording. The HTML this produces is hashed and frozen,
   * so a caller that needs a reproducible artifact pins this.
   */
  now?: Date;
}): { html: string; errors: string[] } {
  const briefs = opts.briefs ?? [];
  const now = (opts.now ?? new Date()).getTime();
  const theme = resolveTheme(opts.brand);
  const byId = new Map([...opts.posts, ...opts.threats, ...briefs].map((i) => [i.id, i]));

  const postBlocks = opts.llm.posts
    .map((p) => {
      const item = byId.get(p.id);
      const href = item?.canonicalUrl ?? "";
      const rt = readingTime(item?.excerpt ?? "");
      return card(
        theme,
        theme.primary,
        `        <mj-text font-size="17px" font-weight="bold" line-height="1.35" padding-bottom="2px" css-class="dm-text">${escapeHtml(item?.title ?? p.id)}</mj-text>
        ${rt ? `<mj-text font-size="12px" color="${theme.muted}" padding-bottom="4px" css-class="dm-muted">${escapeHtml(rt)}</mj-text>` : ""}
        <mj-text font-size="15px" css-class="dm-text">${escapeHtml(p.summary)}</mj-text>
        <mj-button href="${escapeHtml(href)}" align="left" padding="12px 0 0" inner-padding="10px 18px" font-size="14px">${escapeHtml(p.ctaLabel)}</mj-button>`,
      );
    })
    .join("\n");

  // Rows already arrive in urgency order from selectContent (ransomware, then
  // nearest due date); the renderer's job is to make that order visible, not
  // to re-sort it. The left rule and the deadline pill are how it is made
  // visible — the ordering itself stays untouched.
  const threatBlocks = opts.llm.threats
    .map((t) => {
      const item = byId.get(t.id);
      const href = item?.canonicalUrl ?? "";
      const cve = item?.cveIds[0] ?? "";
      const vp = item?.vendorProduct ?? "";
      const sev = severityColor(theme, t.severity);
      const bucket = urgencyBucket(item?.dueDate, now);
      const due = dueDateLabel(item?.dueDate, now);
      const pills = [
        pill(t.severity.toUpperCase(), sev),
        // A plain-text pill, not an emoji: the previous "🔴 RANSOMWARE" had no
        // glyph in the fonts the print pipeline embeds and came out as tofu.
        item?.knownRansomware ? pill("RANSOMWARE", theme.severity.critical ?? sev) : "",
        bucket && due ? pill(due, theme.urgency[bucket]) : "",
      ].filter(Boolean);
      const meta = [cve, vp].filter(Boolean).map(escapeHtml).join(" · ");
      return card(
        theme,
        sev,
        `        <mj-text font-size="12px" line-height="2.1" padding-bottom="6px">${pills.join(" ")}</mj-text>
        ${meta ? `<mj-text font-size="12px" color="${theme.muted}" padding-bottom="2px" css-class="dm-muted">${meta}</mj-text>` : ""}
        <mj-text font-size="17px" font-weight="bold" line-height="1.35" padding-bottom="4px" css-class="dm-text">${escapeHtml(item?.title ?? "")}</mj-text>
        <mj-text font-size="15px" css-class="dm-text">${escapeHtml(t.whyItMatters)}</mj-text>
        <mj-text font-size="13px" padding-top="8px"><a href="${escapeHtml(href)}">Read the advisory</a></mj-text>`,
      );
    })
    .join("\n");

  const briefBlocks = opts.llm.briefs
    .map((b) => {
      const item = byId.get(b.id);
      const href = item?.canonicalUrl ?? "";
      // sourceId is the ingest feed identifier, the only honest attribution
      // available without inventing a publication name.
      const source = item?.sourceId ?? "";
      return card(
        theme,
        theme.border,
        `        <mj-text font-size="17px" font-weight="bold" line-height="1.35" padding-bottom="2px" css-class="dm-text">${escapeHtml(item?.title ?? b.id)}</mj-text>
        ${source ? `<mj-text font-size="12px" color="${theme.muted}" padding-bottom="4px" css-class="dm-muted">via ${escapeHtml(source)}</mj-text>` : ""}
        <mj-text font-size="15px" css-class="dm-text">${escapeHtml(b.summary)}</mj-text>
        <mj-text font-size="13px" padding-top="8px"><a href="${escapeHtml(href)}">Read more</a></mj-text>`,
      );
    })
    .join("\n");

  const promo = opts.brand.promo;
  const promoBlock =
    promo && promo.heading.trim()
      ? `<mj-section padding="20px 16px 8px" css-class="dm-bg">
          <mj-column background-color="${theme.card}" border-left="4px solid ${escapeHtml(opts.brand.primaryColor)}" padding="16px 18px" css-class="dm-card">
            <mj-text font-size="11px" color="${theme.muted}" text-transform="uppercase" letter-spacing="1px" css-class="dm-muted">Sponsored by ${escapeHtml(opts.brand.displayName)}</mj-text>
            <mj-text font-weight="bold" font-size="18px" line-height="1.35" padding-top="2px" css-class="dm-text">${escapeHtml(promo.heading)}</mj-text>
            <mj-text font-size="15px" css-class="dm-text">${escapeHtml(promo.body)}</mj-text>
            ${promo.ctaUrl ? `<mj-button href="${escapeHtml(promo.ctaUrl)}" align="left" padding="12px 0 0" inner-padding="10px 18px" font-size="14px">${escapeHtml(promo.ctaLabel || "Learn more")}</mj-button>` : ""}
          </mj-column>
        </mj-section>`
      : "";

  const briefsSection = briefBlocks
    ? `<mj-section padding="20px 16px 0" css-class="dm-bg"><mj-column>
        <mj-divider border-color="${theme.border}" border-width="1px" padding-bottom="14px" css-class="dm-rule" />
        <mj-text font-size="20px" font-weight="bold" padding-bottom="2px" css-class="dm-text">AI &amp; security this week</mj-text>
        <mj-text font-size="12px" color="${theme.muted}" css-class="dm-muted">Third-party coverage, summarised and attributed — not written by ${escapeHtml(opts.brand.displayName)}.</mj-text>
      </mj-column></mj-section>\n${briefBlocks}`
    : "";

  // Brand-hosted assets only. Anything rendered here is gated by
  // `imageSrcAllowList` in src/qa/gates.ts on exactly the same terms as an
  // href, so a third-party or feed-supplied image fails QA rather than
  // silently opening an egress channel.
  const logoBlock = imageBlock(opts.brand.logoUrl, opts.brand.displayName, "150px", "0 0 10px");
  const heroBlock = (opts.brand.heroImageUrl ?? "").trim()
    ? `<mj-section padding="8px 16px 4px" css-class="dm-bg"><mj-column>
        ${imageBlock(opts.brand.heroImageUrl, `${opts.brand.displayName} — ${opts.issueLabel}`, "568px", "0")}
      </mj-column></mj-section>`
    : "";

  const mjml = subst(readFileSync(shellPath, "utf8"), {
    subject: escapeHtml(opts.llm.subject),
    preheader: escapeHtml(opts.llm.preheader),
    textColor: opts.brand.textColor,
    primaryColor: opts.brand.primaryColor,
    backgroundColor: opts.brand.backgroundColor,
    mutedColor: theme.muted,
    borderColor: theme.border,
    displayName: escapeHtml(opts.brand.displayName),
    issueLabel: escapeHtml(opts.issueLabel),
    archiveUrl: escapeHtml(opts.archiveUrl),
    editorBlurb: escapeHtml(opts.llm.editorBlurb),
    logoBlock,
    heroBlock,
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
  now?: Date;
}): string {
  const briefs = opts.briefs ?? [];
  const now = (opts.now ?? new Date()).getTime();
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
      // Mirrors the pills on the HTML card, in the same order, so the two
      // parts carry the same signal to a reader who only gets text/plain.
      const meta = [
        t.severity.toUpperCase(),
        item?.knownRansomware ? "RANSOMWARE" : "",
        dueDateLabel(item?.dueDate, now),
        item?.vendorProduct,
      ]
        .filter(Boolean)
        .join(" · ");
      return [
        "",
        `${item?.cveIds[0] ?? ""} ${item?.title ?? ""}`.trim(),
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
