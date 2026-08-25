import type { BrandConfig, ContentItem, LlmOutput, QaReport, RelevanceConfig } from "../types";
import { llmCanaryFail } from "../llm/schema";

const CVE_RE = /CVE-\d{4}-\d{4,}/gi;
const HREF_RE = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
// Anchored on a preceding delimiter so `data-src=` is a distinct attribute
// rather than a substring match on this one.
const SRC_RE = /(?:^|[\s"'])src\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const CSS_URL_RE = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;

export function extractHrefs(html: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(HREF_RE);
  while ((m = re.exec(html))) {
    const href = (m[1] ?? m[2] ?? "").replaceAll("&amp;", "&");
    if (href) out.push(href);
  }
  return out;
}

/**
 * Every URL the rendered HTML would make the reader's client fetch.
 *
 * `extractHrefs` deliberately does not cover these: an href is a link the
 * reader chooses to follow, while a `src` or a CSS `url()` is fetched on open.
 * That makes an un-gated one a tracking pixel or an SSRF-adjacent egress
 * channel, so it is held to a stricter list than an href — brand-hosted
 * assets only, never an ingested item URL.
 */
export function extractImageSrcs(html: string): string[] {
  const out: string[] = [];
  for (const re of [new RegExp(SRC_RE), new RegExp(CSS_URL_RE)]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      const src = (m[1] ?? m[2] ?? "").replaceAll("&amp;", "&").trim();
      if (src) out.push(src);
    }
  }
  return out;
}

/**
 * Brand-hosted image origins. Unlike the href list this is not seeded from
 * ingested content: third-party art is unsupported by design, because
 * hotlinking it would leak reader IPs to hosts we do not control.
 */
export function imageSrcAllowList(brand: BrandConfig): Set<string> {
  const set = new Set<string>();
  for (const u of [
    brand.logoUrl,
    brand.heroImageUrl,
    brand.sectionIcons?.threats,
    brand.sectionIcons?.briefs,
    brand.sectionIcons?.posts,
  ]) {
    if (u && u.trim()) set.add(u.trim());
  }
  return set;
}

export function hrefAllowList(opts: {
  items: ContentItem[];
  brand: BrandConfig;
  archiveUrl: string;
}): Set<string> {
  const set = new Set<string>();
  for (const i of opts.items) set.add(i.canonicalUrl);
  for (const u of [
    opts.brand.siteUrl,
    opts.brand.logoUrl,
    opts.brand.unsubscribeUrl,
    opts.brand.preferenceUrl,
    opts.brand.archiveBaseUrl,
    opts.archiveUrl,
    opts.brand.promo?.ctaUrl,
  ]) {
    if (u) set.add(u);
  }
  return set;
}

const PLACEHOLDER_MARKERS = [/\bTODO\b/i, /example\.invalid/i, /\breplace-with\b/i];

/**
 * Must carry a real value before this brand can send.
 *
 * postalAddress and legalName are CAN-SPAM obligations; the rest render into
 * the issue, where a placeholder is visible to every recipient.
 */
const REQUIRED_BRAND_FIELDS: ReadonlyArray<keyof BrandConfig> = [
  "displayName",
  "legalName",
  "postalAddress",
  "fromName",
  "fromEmail",
  "siteUrl",
  "unsubscribeUrl",
  "preferenceUrl",
];

/** May legitimately be empty, but must never carry a placeholder. */
const OPTIONAL_BRAND_FIELDS: ReadonlyArray<keyof BrandConfig> = [
  "replyTo",
  "logoUrl",
  "archiveBaseUrl",
  "advertisementNotice",
  "cdnHost",
];

/**
 * Catch a brand config that is still carrying scaffolding.
 *
 * The unsubscribe gate below only checks that the word "unsubscribe" appears in
 * the HTML, which `https://TODO.example.invalid/unsubscribe` satisfies — so
 * without this the pipeline happily froze and offered for approval an email
 * with no real postal address, no real sender and a dead unsubscribe link.
 */
export function brandCompletenessProblems(brand: BrandConfig): string[] {
  const problems: string[] = [];
  const check = (field: keyof BrandConfig, required: boolean): void => {
    const value = String(brand[field] ?? "").trim();
    if (!value) {
      if (required) problems.push(`brand.${field} is empty`);
      return;
    }
    if (PLACEHOLDER_MARKERS.some((re) => re.test(value))) {
      problems.push(`brand.${field} is still a placeholder: ${value}`);
    }
  };
  for (const field of REQUIRED_BRAND_FIELDS) check(field, true);
  for (const field of OPTIONAL_BRAND_FIELDS) check(field, false);
  return problems;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function fromDomain(email: string): string | undefined {
  const at = email.lastIndexOf("@");
  if (at < 0) return undefined;
  return email.slice(at + 1).toLowerCase();
}

export function runQa(opts: {
  llm: LlmOutput;
  html: string;
  text: string;
  posts: ContentItem[];
  threats: ContentItem[];
  briefs?: ContentItem[];
  brand: BrandConfig;
  relevance: RelevanceConfig;
  archiveUrl: string;
  /** MJML compile errors. A template that failed to render is not sendable. */
  renderErrors?: string[];
  /**
   * Fail on placeholder brand config rather than warn. Set outside development,
   * where fixtures legitimately run on scaffolding.
   */
  requireCompleteBrand?: boolean;
}): QaReport {
  const failures: string[] = [];
  const warnings: string[] = [];
  const briefs = opts.briefs ?? [];
  const items = [...opts.posts, ...opts.threats, ...briefs];
  const ids = new Set(items.map((i) => i.id));
  const sourceCves = new Set(items.flatMap((i) => i.cveIds.map((c) => c.toUpperCase())));

  if (!opts.posts.length && !opts.relevance.allowThreatOnly) {
    failures.push("posts required unless allowThreatOnly");
  }
  if (!opts.threats.length && !opts.relevance.allowPostsOnly) {
    failures.push("threats required unless allowPostsOnly");
  }
  if (!opts.posts.length && !opts.threats.length && !briefs.length) {
    failures.push("empty issue");
  }

  if (opts.llm.subject.length > opts.relevance.subjectMaxChars) {
    failures.push(`subject longer than ${opts.relevance.subjectMaxChars}`);
  }
  if (opts.llm.subject === opts.llm.subject.toUpperCase() && /[A-Z]/.test(opts.llm.subject)) {
    failures.push("subject is ALL CAPS");
  }
  if (!opts.llm.preheader.trim()) failures.push("preheader required");
  if (!opts.text.trim() || opts.text.length < 80) failures.push("plaintext part missing or too short");

  const htmlBytes = Buffer.byteLength(opts.html, "utf8");
  if (htmlBytes >= opts.relevance.gmailClipBytes) {
    failures.push(`HTML ${htmlBytes} bytes exceeds Gmail clip budget ${opts.relevance.gmailClipBytes}`);
  } else if (htmlBytes >= opts.relevance.gmailWarnBytes) {
    warnings.push(`HTML ${htmlBytes} bytes near Gmail clip (warn at ${opts.relevance.gmailWarnBytes})`);
  }

  if (!opts.html.toLowerCase().includes("unsubscribe")) {
    failures.push("unsubscribe footer missing");
  }

  failures.push(...llmCanaryFail(opts.llm));

  for (const p of opts.llm.posts) {
    if (!ids.has(p.id)) failures.push(`post id not in allow-list: ${p.id}`);
  }
  for (const t of opts.llm.threats) {
    if (!ids.has(t.id)) failures.push(`threat id not in allow-list: ${t.id}`);
  }
  for (const b of opts.llm.briefs) {
    if (!ids.has(b.id)) failures.push(`brief id not in allow-list: ${b.id}`);
  }
  // A brief must never be presented as one of Aspire's own posts — that is
  // the exact mislabelling that motivated a distinct content kind.
  for (const b of opts.llm.briefs) {
    const item = items.find((i) => i.id === b.id);
    if (item && item.kind !== "brief") {
      failures.push(`brief id refers to a non-brief item: ${b.id}`);
    }
  }
  for (const p of opts.llm.posts) {
    const item = items.find((i) => i.id === p.id);
    if (item && item.kind === "brief") {
      failures.push(`post id refers to a third-party brief, not an Aspire article: ${p.id}`);
    }
  }

  const allow = hrefAllowList({ items, brand: opts.brand, archiveUrl: opts.archiveUrl });
  const shorteners = new Set(opts.relevance.shortenerHosts.map((h) => h.toLowerCase()));
  const mailDomain = fromDomain(opts.brand.fromEmail);

  for (const href of extractHrefs(opts.html)) {
    if (href.startsWith("{{") || href.startsWith("%")) continue;
    if (href.startsWith("mailto:")) {
      const addr = href.slice(7);
      const d = fromDomain(addr);
      if (!d || (mailDomain && d !== mailDomain && !d.endsWith(`.${mailDomain}`))) {
        failures.push(`mailto not on from-domain: ${href}`);
      }
      continue;
    }
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      failures.push(`invalid href ${href}`);
      continue;
    }
    if (url.protocol === "javascript:" || url.protocol === "data:") {
      failures.push(`blocked scheme ${href}`);
      continue;
    }
    const host = url.hostname.toLowerCase();
    if (shorteners.has(host) || [...shorteners].some((s) => host === s || host.endsWith(`.${s}`))) {
      failures.push(`shortener href ${href}`);
      continue;
    }
    const exact = allow.has(href) || allow.has(url.toString());
    const originOk = [...allow].some((a) => {
      try {
        return new URL(a).origin === url.origin;
      } catch {
        return false;
      }
    });
    // Allow exact canonical URLs; also allow archive URLs under archiveBaseUrl origin+path prefix
    const archiveOk =
      href.startsWith(opts.brand.archiveBaseUrl) || href.startsWith(opts.archiveUrl.split("?")[0] ?? "");
    if (!exact && !archiveOk) {
      // Origin match is NOT enough by itself (would allow extra paths). Fail extra hrefs.
      void originOk;
      void hostOf;
      failures.push(`href not on ingest/config allow-list: ${href}`);
    }
  }

  // Image sources are gated separately and more strictly than hrefs, because
  // the reader's client fetches them on open without any action from them.
  const imageAllow = imageSrcAllowList(opts.brand);
  const cdnHost = (opts.brand.cdnHost ?? "").trim().toLowerCase();
  for (const src of extractImageSrcs(opts.html)) {
    if (src.startsWith("{{") || src.startsWith("%")) continue;
    if (imageAllow.has(src)) continue;
    let url: URL;
    try {
      url = new URL(src);
    } catch {
      failures.push(`invalid image src ${src}`);
      continue;
    }
    if (url.protocol !== "https:") {
      // Covers data:, javascript: and cleartext http: in one rule. A data:
      // image would also defeat the allow-list by carrying its own payload.
      failures.push(`image src must be https: ${src}`);
      continue;
    }
    const host = url.hostname.toLowerCase();
    if (cdnHost && (host === cdnHost || host.endsWith(`.${cdnHost}`))) continue;
    failures.push(`image src not on brand allow-list: ${src}`);
  }

  for (const err of opts.renderErrors ?? []) {
    failures.push(`MJML render error: ${err}`);
  }

  // Visible in development so the gap is obvious long before it blocks a send.
  const brandProblems = brandCompletenessProblems(opts.brand);
  (opts.requireCompleteBrand ? failures : warnings).push(...brandProblems);

  const blob = `${opts.html}\n${opts.text}\n${JSON.stringify(opts.llm)}`;
  for (const m of blob.toUpperCase().match(CVE_RE) ?? []) {
    if (!sourceCves.has(m.toUpperCase())) {
      failures.push(`CVE not in ingested source: ${m}`);
    }
  }

  return { ok: failures.length === 0, failures, warnings };
}
