import type { BrandConfig, ContentItem, LlmOutput, QaReport, RelevanceConfig } from "../types";
import { llmCanaryFail } from "../llm/schema";

const CVE_RE = /CVE-\d{4}-\d{4,}/gi;
const HREF_RE = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

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
  const items = [...opts.posts, ...opts.threats];
  const ids = new Set(items.map((i) => i.id));
  const sourceCves = new Set(items.flatMap((i) => i.cveIds.map((c) => c.toUpperCase())));

  if (!opts.posts.length && !opts.relevance.allowThreatOnly) {
    failures.push("posts required unless allowThreatOnly");
  }
  if (!opts.threats.length && !opts.relevance.allowPostsOnly) {
    failures.push("threats required unless allowPostsOnly");
  }
  if (!opts.posts.length && !opts.threats.length) {
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
