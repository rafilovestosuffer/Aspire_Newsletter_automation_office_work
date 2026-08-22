import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig, ContentItem, LlmOutput, NewsletterIssue, QaReport } from "../types";
import { sha256Hex } from "../domain/hash";
import { issueKeyToPath } from "../domain/issueKey";
import { fixtureSummarize, summarizeSelected, untrustedDataRegion } from "../llm/summarize";
import { compileMjml, compilePlaintext } from "../render/compile";
import { runQa } from "../qa/gates";
import { selectContent } from "../select/score";

export interface AssembleResult {
  issue: NewsletterIssue;
  llm: LlmOutput;
  html: string;
  text: string;
  qa: QaReport;
  untrustedPrompt: string;
  artifactDir: string;
}

/** `root` is the artifacts directory (contains `issues/`). */
export function artifactDirFor(root: string, issueKey: string, revision: number): string {
  return join(root, "issues", issueKeyToPath(issueKey), `r${revision}`);
}

/**
 * SHA-256 of one revision's frozen artifact, or undefined if it is not on disk.
 *
 * Read from the artifact rather than issues.html_sha256, which only ever holds
 * the *current* revision — so an archive signature minted against the row
 * stopped validating for r1 the moment r2 was assembled.
 */
export function frozenHtmlSha256(opts: {
  artifactsRoot: string;
  issueKey: string;
  revision: number;
}): string | undefined {
  const file = join(artifactDirFor(opts.artifactsRoot, opts.issueKey, opts.revision), "email.html");
  if (!existsSync(file)) return undefined;
  return sha256Hex(readFileSync(file, "utf8"));
}

export function loadFrozenHtml(opts: {
  artifactsRoot: string;
  issueKey: string;
  revision: number;
  expectedSha256?: string;
}): string {
  const file = join(artifactDirFor(opts.artifactsRoot, opts.issueKey, opts.revision), "email.html");
  if (!existsSync(file)) {
    throw new Error(`frozen html missing at ${file}`);
  }
  const html = readFileSync(file, "utf8");
  if (opts.expectedSha256 && sha256Hex(html) !== opts.expectedSha256) {
    throw new Error("frozen html sha256 mismatch");
  }
  return html;
}

export async function assembleFromItems(opts: {
  issue: NewsletterIssue;
  items: ContentItem[];
  config: AppConfig;
  now: Date;
  artifactsRoot: string;
  publicBaseUrl: string;
  llmProvider: string;
  llmApiKey: string;
  llmModel?: string;
  /** Outside development, placeholder brand config fails QA instead of warning. */
  requireCompleteBrand?: boolean;
}): Promise<AssembleResult> {
  const selected = selectContent(opts.items, opts.now, opts.config.relevance);
  const archiveUrl = `${opts.publicBaseUrl.replace(/\/$/, "")}/archive/${issueKeyToPath(opts.issue.issueKey)}/r/${opts.issue.revision}`;

  if (!selected.posts.length && !selected.threats.length && !selected.briefs.length) {
    const empty: AssembleResult = {
      issue: { ...opts.issue, status: "skipped", postIds: [], threatIds: [], briefIds: [] },
      llm: fixtureSummarize([], [], []),
      html: "",
      text: "",
      qa: { ok: false, failures: ["empty issue"], warnings: [] },
      untrustedPrompt: "",
      artifactDir: artifactDirFor(opts.artifactsRoot, opts.issue.issueKey, opts.issue.revision),
    };
    return empty;
  }

  const llm = await summarizeSelected({
    posts: selected.posts,
    threats: selected.threats,
    briefs: selected.briefs,
    provider: opts.llmProvider,
    apiKey: opts.llmApiKey,
    model: opts.llmModel,
  });
  const untrustedPrompt = untrustedDataRegion(selected.posts, selected.threats, selected.briefs);
  const issueLabel = `${opts.issue.isoWeek} · r${opts.issue.revision}`;
  const { html, errors } = compileMjml({
    brand: opts.config.brand,
    issueLabel,
    archiveUrl,
    llm,
    posts: selected.posts,
    threats: selected.threats,
    briefs: selected.briefs,
  });
  const text = compilePlaintext({
    brand: opts.config.brand,
    issueLabel,
    archiveUrl,
    llm,
    posts: selected.posts,
    threats: selected.threats,
    briefs: selected.briefs,
  });
  const qa = runQa({
    llm,
    html,
    text,
    posts: selected.posts,
    threats: selected.threats,
    briefs: selected.briefs,
    brand: opts.config.brand,
    relevance: opts.config.relevance,
    archiveUrl,
    renderErrors: errors,
    requireCompleteBrand: opts.requireCompleteBrand,
  });

  const htmlSha256 = html ? sha256Hex(html) : undefined;
  const textSha256 = text ? sha256Hex(text) : undefined;
  const status = qa.ok ? "assembled" : "qa_failed";
  const issue: NewsletterIssue = {
    ...opts.issue,
    status,
    subject: llm.subject,
    preheader: llm.preheader,
    htmlSha256,
    textSha256,
    postIds: selected.posts.map((p) => p.id),
    threatIds: selected.threats.map((t) => t.id),
    briefIds: selected.briefs.map((b) => b.id),
  };

  const dir = artifactDirFor(opts.artifactsRoot, issue.issueKey, issue.revision);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "email.html"), html);
  writeFileSync(join(dir, "email.txt"), text);
  writeFileSync(join(dir, "issue.json"), JSON.stringify(issue, null, 2));
  writeFileSync(join(dir, "qa-report.json"), JSON.stringify(qa, null, 2));
  writeFileSync(join(dir, "model-out.json"), JSON.stringify(llm, null, 2));
  writeFileSync(join(dir, "prompt-in.json"), JSON.stringify({ untrustedPrompt }, null, 2));

  return { issue, llm, html, text, qa, untrustedPrompt, artifactDir: dir };
}
