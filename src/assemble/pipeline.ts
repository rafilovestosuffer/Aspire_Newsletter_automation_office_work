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
}): Promise<AssembleResult> {
  const selected = selectContent(opts.items, opts.now, opts.config.relevance);
  const archiveUrl = `${opts.publicBaseUrl.replace(/\/$/, "")}/archive/${issueKeyToPath(opts.issue.issueKey)}/r/${opts.issue.revision}`;

  if (!selected.posts.length && !selected.threats.length) {
    const empty: AssembleResult = {
      issue: { ...opts.issue, status: "skipped", postIds: [], threatIds: [] },
      llm: fixtureSummarize([], []),
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
    provider: opts.llmProvider,
    apiKey: opts.llmApiKey,
  });
  const untrustedPrompt = untrustedDataRegion(selected.posts, selected.threats);
  const issueLabel = `${opts.issue.isoWeek} · r${opts.issue.revision}`;
  const { html, errors } = compileMjml({
    brand: opts.config.brand,
    issueLabel,
    archiveUrl,
    llm,
    posts: selected.posts,
    threats: selected.threats,
  });
  const text = compilePlaintext({
    brand: opts.config.brand,
    issueLabel,
    archiveUrl,
    llm,
    posts: selected.posts,
    threats: selected.threats,
  });
  const qa = runQa({
    llm,
    html,
    text,
    posts: selected.posts,
    threats: selected.threats,
    brand: opts.config.brand,
    relevance: opts.config.relevance,
    archiveUrl,
  });
  if (errors.length) {
    qa.warnings.push(...errors);
  }

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
