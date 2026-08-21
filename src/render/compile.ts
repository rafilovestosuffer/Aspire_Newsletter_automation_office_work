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

export function compileMjml(opts: {
  brand: BrandConfig;
  issueLabel: string;
  archiveUrl: string;
  llm: LlmOutput;
  posts: ContentItem[];
  threats: ContentItem[];
}): { html: string; errors: string[] } {
  const byId = new Map([...opts.posts, ...opts.threats].map((i) => [i.id, i]));
  const postBlocks = opts.llm.posts
    .map((p) => {
      const item = byId.get(p.id);
      const href = item?.canonicalUrl ?? "";
      return `<mj-section padding="4px 16px"><mj-column>
        <mj-text font-weight="bold">${escapeHtml(item?.title ?? p.id)}</mj-text>
        <mj-text>${escapeHtml(p.summary)}</mj-text>
        <mj-button href="${escapeHtml(href)}">${escapeHtml(p.ctaLabel)}</mj-button>
      </mj-column></mj-section>`;
    })
    .join("\n");

  const threatBlocks = opts.llm.threats
    .map((t) => {
      const item = byId.get(t.id);
      const href = item?.canonicalUrl ?? "";
      const cve = item?.cveIds[0] ?? "";
      return `<mj-section padding="4px 16px"><mj-column>
        <mj-text font-weight="bold">${escapeHtml(cve)} · ${escapeHtml(t.severity)} · ${escapeHtml(item?.title ?? "")}</mj-text>
        <mj-text>${escapeHtml(t.whyItMatters)}</mj-text>
        <mj-text font-size="14px"><a href="${escapeHtml(href)}">Source</a></mj-text>
      </mj-column></mj-section>`;
    })
    .join("\n");

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
    legalName: escapeHtml(opts.brand.legalName),
    postalAddress: escapeHtml(opts.brand.postalAddress),
    advertisementNotice: escapeHtml(opts.brand.advertisementNotice),
    unsubscribeUrl: escapeHtml(opts.brand.unsubscribeUrl),
    preferenceUrl: escapeHtml(opts.brand.preferenceUrl),
    ghlUnsubscribeMergeTag: escapeHtml(opts.brand.ghlUnsubscribeMergeTag),
  });

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
}): string {
  const byId = new Map([...opts.posts, ...opts.threats].map((i) => [i.id, i]));
  const lines = [
    `${opts.brand.displayName} Weekly — ${opts.issueLabel}`,
    opts.llm.subject,
    opts.llm.preheader,
    "",
    opts.llm.editorBlurb,
    "",
    "From the blog",
    ...opts.llm.posts.flatMap((p) => {
      const item = byId.get(p.id);
      return ["", item?.title ?? p.id, p.summary, item?.canonicalUrl ?? ""];
    }),
    "",
    "This week in threats",
    "Public KEV data is CC0. This is not a CISA or DHS product.",
    ...opts.llm.threats.flatMap((t) => {
      const item = byId.get(t.id);
      return ["", `${item?.cveIds[0] ?? ""} ${item?.title ?? ""} (${t.severity})`, t.whyItMatters, item?.canonicalUrl ?? ""];
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
