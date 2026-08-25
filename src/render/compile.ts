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

/**
 * One story, set as an editorial row rather than a box.
 *
 * The previous design ran threats, briefs and posts through one identical
 * card: same fill, same border, same left rule. Nine identical rectangles in a
 * row, with no lead, no rank and no rhythm. Here a hairline rule separates
 * stories and a numeral ranks them, so whitespace does the structural work
 * that a border was doing badly — the thing every newsletter worth studying
 * has in common ("using the space without filling the space").
 *
 * The numeral and the body sit in an `mj-group`, which keeps them side by side
 * on mobile instead of stacking the numeral onto its own line.
 */
function storyRow(opts: {
  theme: Theme;
  numeral: string;
  /** Severity colour for a KEV item; undefined leaves the numeral muted. */
  accent?: string;
  /** First row of a section renders without a rule above it. */
  first: boolean;
  inner: string;
}): string {
  const { theme } = opts;
  // One mj-text wrapping a two-cell table, rather than an mj-group of two
  // mj-columns. MJML emits a block of Outlook conditional markup per group and
  // per column, and at fourteen stories that pushed the issue to 97KB —
  // past the Gmail warn threshold and within sight of the 102KB clip. This
  // renders the same layout for a fraction of the bytes, and a table cell does
  // not stack on mobile the way a column does.
  const rule = opts.first ? "" : `border-top:1px solid ${theme.border};`;
  const stripe = opts.accent ? `border-left:3px solid ${opts.accent};padding-left:11px;` : "";
  return `<mj-section padding="0 16px" css-class="dm-bg"><mj-column>
        <mj-text padding="0" css-class="dm-rule" container-background-color="transparent">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="${rule}">
            <tr>
              <td width="52" valign="top" style="${stripe}padding:18px 12px 16px 0;font-family:${theme.displayFont};font-size:30px;line-height:1;color:${
                opts.accent ?? theme.muted
              };" class="dm-muted">${escapeHtml(opts.numeral)}</td>
              <td valign="top" style="padding:18px 0 16px;">
${opts.inner}
              </td>
            </tr>
          </table>
        </mj-text>
      </mj-column></mj-section>`;
}

/** An image block, or "" when the brand has not supplied that asset. */
function imageBlock(
  url: string | undefined,
  alt: string,
  width: string,
  padding: string,
  align = "left",
): string {
  const trimmed = (url ?? "").trim();
  if (!trimmed) return "";
  return `<mj-image src="${escapeHtml(trimmed)}" alt="${escapeHtml(alt)}" width="${width}" align="${align}" padding="${padding}" />`;
}

/**
 * A section transition: ornament mark, then an all-caps kicker.
 *
 * Replaces a plain bold heading over a grey rule. The ornament is the device
 * The 19th News uses to mark a transition without spending a whole rule on it.
 */
function sectionHeader(theme: Theme, opts: { kicker: string; title: string; note?: string; icon?: string }): string {
  return `<mj-section padding="26px 16px 4px" css-class="dm-bg"><mj-column>
        ${opts.icon ? imageBlock(opts.icon, "", "20px", "0 0 8px") : `<mj-text padding="0 0 8px"><span style="display:inline-block;width:44px;height:3px;background:${theme.ornament};"></span></mj-text>`}
        <mj-text font-family="${theme.bodyFont}" font-size="11px" letter-spacing="1.5px" text-transform="uppercase" color="${theme.ornament}" font-weight="bold" padding="0 0 4px">${escapeHtml(opts.kicker)}</mj-text>
        <mj-text font-family="${theme.displayFont}" font-size="24px" font-weight="bold" line-height="1.25" padding="0 0 4px" css-class="dm-text">${escapeHtml(opts.title)}</mj-text>
        ${opts.note ? `<mj-text font-size="12px" line-height="1.5" color="${theme.muted}" padding="2px 0 0" css-class="dm-muted">${escapeHtml(opts.note)}</mj-text>` : ""}
      </mj-column></mj-section>`;
}

/**
 * A centred primary CTA, built as a table rather than an mj-button so it can
 * live inside the story row's mj-text.
 *
 * Centre is the default for a primary action (Litmus); left is for a secondary
 * in-line one. The padding gives a ~46px tap target, above the 44px minimum.
 * The inline colour and text-decoration beat the stylesheet's link rule.
 */
function cta(theme: Theme, href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:18px auto 4px;">
                  <tr><td align="center" bgcolor="${theme.primary}" style="border-radius:3px;">
                    <a href="${escapeHtml(href)}" style="display:inline-block;padding:14px 30px;font-family:${theme.bodyFont};font-size:14px;font-weight:bold;color:#ffffff;text-decoration:none;">${escapeHtml(label)}</a>
                  </td></tr>
                </table>`;
}

/**
 * "In this issue" — a numbered contents list, deliberately not a jump menu.
 *
 * In-email anchor links are unsupported in the Gmail iOS and Android apps and
 * in Outlook for Mac, which is most opens; a jump link there does nothing, or
 * worse, opens a blank window. So each line links to that item's canonical URL
 * instead, which works in every client and always does something useful.
 *
 * Every count is derived from the selected content rather than written by
 * hand, so the block is true by construction and cannot drift from the issue.
 */
function buildContents(
  theme: Theme,
  data: {
    threats: Array<ContentItem | undefined>;
    briefs: Array<ContentItem | undefined>;
    posts: Array<ContentItem | undefined>;
    now: number;
  },
): string {
  const threats = data.threats.filter((i): i is ContentItem => Boolean(i));
  const ransomware = threats.filter((t) => t.knownRansomware).length;
  const overdue = threats.filter((t) => urgencyBucket(t.dueDate, data.now) === "overdue").length;

  const entries: Array<{ title: string; detail: string; href?: string }> = [];
  if (threats.length) {
    entries.push({
      title: "Patch board",
      detail: [
        `${threats.length} KEV item${threats.length === 1 ? "" : "s"}`,
        ransomware ? `${ransomware} ransomware-linked` : "",
        overdue ? `${overdue} past its federal deadline` : "",
      ]
        .filter(Boolean)
        .join(" · "),
      href: threats[0]?.canonicalUrl,
    });
  }
  const briefs = data.briefs.filter((i): i is ContentItem => Boolean(i));
  if (briefs.length) {
    entries.push({
      title: "AI & security this week",
      detail: `${briefs.length} attributed brief${briefs.length === 1 ? "" : "s"}`,
      href: briefs[0]?.canonicalUrl,
    });
  }
  const posts = data.posts.filter((i): i is ContentItem => Boolean(i));
  if (posts.length) {
    entries.push({
      title: "From the blog",
      detail: posts[0]?.title ?? `${posts.length} posts`,
      href: posts[0]?.canonicalUrl,
    });
  }
  if (!entries.length) return "";

  const rows = entries
    .map((e, i) => {
      const label = escapeHtml(e.title);
      const linked = e.href ? `<a href="${escapeHtml(e.href)}">${label}</a>` : label;
      return `<tr>
              <td style="padding:7px 12px 7px 0;font-family:${theme.displayFont};font-size:16px;color:${theme.muted};vertical-align:top;width:30px;">${numeral(i)}</td>
              <td class="dm-text" style="padding:7px 0;font-family:${theme.bodyFont};font-size:14px;line-height:1.45;vertical-align:top;"><strong>${linked}</strong><br/><span class="dm-muted" style="color:${theme.muted};font-size:13px;">${escapeHtml(e.detail)}</span></td>
            </tr>`;
    })
    .join("");

  return `<mj-section padding="18px 16px 4px" css-class="dm-bg"><mj-column>
        <mj-text padding="0">
          <div style="font-family:${theme.bodyFont};font-size:11px;letter-spacing:1.5px;text-transform:uppercase;font-weight:bold;color:${theme.ornament};padding-bottom:4px;">In this issue</div>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${rows}</table>
        </mj-text>
      </mj-column></mj-section>`;
}

/** Two-digit story numeral: 01, 02, ... */
function numeral(i: number): string {
  return String(i + 1).padStart(2, "0");
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
    .map((p, i) => {
      const item = byId.get(p.id);
      const href = item?.canonicalUrl ?? "";
      const rt = readingTime(item?.excerpt ?? "");
      return storyRow({
        theme,
        numeral: numeral(i),
        first: i === 0,
        inner: `                ${rt ? `<div class="dm-muted" style="font-family:${theme.bodyFont};font-size:11px;letter-spacing:0.5px;text-transform:uppercase;color:${theme.muted};padding-bottom:5px;">${escapeHtml(rt)}</div>` : ""}
                <div class="dm-text" style="font-family:${theme.displayFont};font-size:19px;font-weight:bold;line-height:1.3;padding-bottom:6px;">${escapeHtml(item?.title ?? p.id)}</div>
                <div class="dm-text" style="font-size:15px;line-height:1.6;">${escapeHtml(p.summary)}</div>
                <div style="font-family:${theme.bodyFont};font-size:13px;padding-top:9px;"><a href="${escapeHtml(href)}">${escapeHtml(p.ctaLabel)}</a></div>`,
      });
    })
    .join("\n");

  // Rows already arrive in urgency order from selectContent (ransomware, then
  // nearest due date); the renderer's job is to make that order visible, not
  // to re-sort it. The lead treatment on row one and the severity-coloured
  // numeral rule are how it is made visible — the ordering stays untouched.
  const threatBlocks = opts.llm.threats
    .map((t, i) => {
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
      // The first item is the lead: set larger, and the only one carrying a
      // button. Everything after it is compact. A layout with one gear was
      // what made nine items read as an undifferentiated list.
      const lead = i === 0;
      return storyRow({
        theme,
        numeral: numeral(i),
        accent: sev,
        first: i === 0,
        inner: `                <div style="font-family:${theme.bodyFont};font-size:12px;line-height:2.2;padding-bottom:7px;">${pills.join(" ")}</div>
                ${meta ? `<div class="dm-muted" style="font-family:${theme.bodyFont};font-size:11px;letter-spacing:0.5px;color:${theme.muted};padding-bottom:5px;">${meta}</div>` : ""}
                <div class="dm-text" style="font-family:${theme.displayFont};font-size:${lead ? "23px" : "18px"};font-weight:bold;line-height:1.25;padding-bottom:6px;">${escapeHtml(item?.title ?? "")}</div>
                <div class="dm-text" style="font-size:${lead ? "16px" : "15px"};line-height:1.6;">${escapeHtml(t.whyItMatters)}</div>
                ${lead ? cta(theme, href, "Read the advisory") : `<div style="font-family:${theme.bodyFont};font-size:13px;padding-top:9px;"><a href="${escapeHtml(href)}">Read the advisory</a></div>`}`,
      });
    })
    .join("\n");

  const briefBlocks = opts.llm.briefs
    .map((b, i) => {
      const item = byId.get(b.id);
      const href = item?.canonicalUrl ?? "";
      // sourceId is the ingest feed identifier, the only honest attribution
      // available without inventing a publication name.
      const source = item?.sourceId ?? "";
      return storyRow({
        theme,
        numeral: numeral(i),
        first: i === 0,
        inner: `                ${source ? `<div class="dm-muted" style="font-family:${theme.bodyFont};font-size:11px;letter-spacing:0.5px;text-transform:uppercase;color:${theme.muted};padding-bottom:5px;">via ${escapeHtml(source)}</div>` : ""}
                <div class="dm-text" style="font-family:${theme.displayFont};font-size:19px;font-weight:bold;line-height:1.3;padding-bottom:6px;">${escapeHtml(item?.title ?? b.id)}</div>
                <div class="dm-text" style="font-size:15px;line-height:1.6;">${escapeHtml(b.summary)}</div>
                <div style="font-family:${theme.bodyFont};font-size:13px;padding-top:9px;"><a href="${escapeHtml(href)}">Read more</a></div>`,
      });
    })
    .join("\n");

  const promo = opts.brand.promo;
  // The promo keeps a tinted panel on purpose. It is the one block that is
  // ours rather than editorial, and the reader is entitled to see the seam.
  const promoBlock =
    promo && promo.heading.trim()
      ? `<mj-section padding="26px 16px 8px" css-class="dm-bg">
          <mj-column background-color="${theme.card}" border-left="3px solid ${escapeHtml(opts.brand.primaryColor)}" padding="20px 22px" css-class="dm-card">
            <mj-text font-family="${theme.bodyFont}" font-size="11px" color="${theme.muted}" text-transform="uppercase" letter-spacing="1.5px" font-weight="bold" padding="0 0 6px" css-class="dm-muted">Sponsored by ${escapeHtml(opts.brand.displayName)}</mj-text>
            <mj-text font-family="${theme.displayFont}" font-weight="bold" font-size="21px" line-height="1.3" padding="0 0 6px" css-class="dm-text">${escapeHtml(promo.heading)}</mj-text>
            <mj-text font-size="15px" line-height="1.6" padding="0" css-class="dm-text">${escapeHtml(promo.body)}</mj-text>
            ${promo.ctaUrl ? `<mj-text padding="0">${cta(theme, promo.ctaUrl, promo.ctaLabel || "Learn more")}</mj-text>` : ""}
          </mj-column>
        </mj-section>`
      : "";

  const briefsSection = briefBlocks
    ? `${sectionHeader(theme, {
        kicker: "Elsewhere",
        title: "AI & security this week",
        note: `Third-party coverage, summarised and attributed — not written by ${opts.brand.displayName}.`,
        icon: opts.brand.sectionIcons?.briefs,
      })}\n${briefBlocks}`
    : "";

  const threatsSection = sectionHeader(theme, {
    kicker: "Patch board",
    title: "This week's KEV items",
    note: "Sorted ransomware-linked first, then nearest CISA remediation deadline. Public CISA KEV data is CC0 — this newsletter is not a CISA or DHS product and does not use agency marks.",
    icon: opts.brand.sectionIcons?.threats,
  });

  const postsSection = postBlocks
    ? sectionHeader(theme, {
        kicker: "Our own writing",
        title: `From the ${opts.brand.displayName} blog`,
        icon: opts.brand.sectionIcons?.posts,
      })
    : "";

  const contentsBlock = buildContents(theme, {
    threats: opts.llm.threats.map((t) => byId.get(t.id)),
    briefs: opts.llm.briefs.map((b) => byId.get(b.id)),
    posts: opts.llm.posts.map((p) => byId.get(p.id)),
    now,
  });

  // Brand-hosted assets only. Anything rendered here is gated by
  // `imageSrcAllowList` in src/qa/gates.ts on exactly the same terms as an
  // href, so a third-party or feed-supplied image fails QA rather than
  // silently opening an egress channel.
  // A brand that supplies a raster logo gets it; otherwise the wordmark is
  // live text. Text is the better default: many corporate clients block images
  // by default, an image needs a second asset to stay legible in dark mode,
  // and a screen reader can read text. `logoUrl` stays honoured so the field
  // is a real choice rather than dead config.
  const logoBlock = (opts.brand.logoUrl ?? "").trim()
    ? `${imageBlock(opts.brand.logoUrl, `${opts.brand.displayName} Weekly`, "170px", "0 0 8px")}
        <mj-text padding="6px 0 0"><span style="display:block;height:3px;background:${theme.primary};line-height:3px;font-size:0;">&nbsp;</span></mj-text>`
    : `<mj-text padding="0 0 2px">
          <span style="font-family:${theme.displayFont};font-size:34px;font-weight:bold;letter-spacing:-0.3px;" class="dm-text">${escapeHtml(opts.brand.displayName)}</span>
          <span style="font-family:${theme.bodyFont};font-size:13px;letter-spacing:4px;color:${theme.muted};padding-left:10px;" class="dm-muted">WEEKLY</span>
        </mj-text>
        <mj-text padding="6px 0 0"><span style="display:block;height:3px;background:${theme.primary};line-height:3px;font-size:0;">&nbsp;</span></mj-text>`;

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
    displayFont: theme.displayFont,
    bodyFont: theme.bodyFont,
    ornamentColor: theme.ornament,
    displayName: escapeHtml(opts.brand.displayName),
    issueLabel: escapeHtml(opts.issueLabel),
    archiveUrl: escapeHtml(opts.archiveUrl),
    editorBlurb: escapeHtml(opts.llm.editorBlurb),
    logoBlock,
    heroBlock,
    contentsBlock,
    threatsSection,
    postsSection,
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

/** Plaintext twin of `buildContents`, from the same derived counts. */
function contentsLines(
  llm: LlmOutput,
  byId: Map<string, ContentItem>,
  now: number,
): string[] {
  const threats = llm.threats.map((t) => byId.get(t.id)).filter((i): i is ContentItem => Boolean(i));
  const ransomware = threats.filter((t) => t.knownRansomware).length;
  const overdue = threats.filter((t) => urgencyBucket(t.dueDate, now) === "overdue").length;
  const out = ["IN THIS ISSUE"];
  let n = 0;
  if (threats.length) {
    out.push(
      `${String(++n).padStart(2, "0")}  Patch board — ${[
        `${threats.length} KEV item${threats.length === 1 ? "" : "s"}`,
        ransomware ? `${ransomware} ransomware-linked` : "",
        overdue ? `${overdue} past its federal deadline` : "",
      ]
        .filter(Boolean)
        .join(" · ")}`,
    );
  }
  if (llm.briefs.length) {
    out.push(
      `${String(++n).padStart(2, "0")}  AI & security this week — ${llm.briefs.length} attributed brief${
        llm.briefs.length === 1 ? "" : "s"
      }`,
    );
  }
  if (llm.posts.length) {
    const lead = byId.get(llm.posts[0]?.id ?? "")?.title;
    out.push(`${String(++n).padStart(2, "0")}  From the blog — ${lead ?? `${llm.posts.length} posts`}`);
  }
  out.push("");
  return out.length > 2 ? out : [];
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
    // Mirrors the "In this issue" block in the HTML. A text-only reader gets
    // the same map of the issue, derived from the same counts.
    ...contentsLines(opts.llm, byId, now),
    "PATCH BOARD — This week's KEV items",
    "Sorted ransomware-linked first, then nearest CISA remediation deadline.",
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
          "ELSEWHERE — AI & security this week",
          `Third-party coverage, summarised and attributed — not written by ${opts.brand.displayName}.`,
          ...opts.llm.briefs.flatMap((b) => {
            const item = byId.get(b.id);
            return ["", item?.title ?? b.id, `via ${item?.sourceId ?? ""}`, b.summary, item?.canonicalUrl ?? ""];
          }),
        ]
      : []),
    "",
    `FROM THE BLOG — written by ${opts.brand.displayName}`,
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
