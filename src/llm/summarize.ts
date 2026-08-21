import type { ContentItem, LlmOutput } from "../types";
import { parseLlmJson } from "./schema";

function padSummary(seed: string, title: string): string {
  const base = `${seed} This original note is written for the weekly briefing and is not a reprint of the source body. It covers ${title.replace(/\.$/, "")} for operators who need the public link, not a paste of the feed.`;
  const words = base.split(/\s+/);
  if (words.length > 60) return words.slice(0, 58).join(" ") + ".";
  return base;
}

/** Deterministic local summarizer. Used when LLM_PROVIDER=fixture or no API key. */
export function fixtureSummarize(posts: ContentItem[], threats: ContentItem[]): LlmOutput {
  const leadPost = posts[0];
  const leadThreat = threats[0];
  const subjectCore = leadPost?.title ?? leadThreat?.title ?? "Weekly authority briefing";
  const subject = subjectCore.length <= 60 ? subjectCore : subjectCore.slice(0, 57) + "...";
  const editorBlurb = [
    leadPost ? `This issue opens with ${leadPost.title}.` : "This issue leads with public vulnerability intel.",
    leadThreat
      ? `On the threat desk, ${leadThreat.cveIds[0] ?? "a KEV item"} is in the selected set.`
      : "No threat items were selected.",
  ].join(" ");

  return parseLlmJson({
    subject,
    preheader: "Selected posts and public KEV items from this week's window.",
    editorBlurb,
    posts: posts.map((p) => ({
      id: p.id,
      summary: padSummary(p.excerpt || p.title, p.title),
      ctaLabel: "Read the post",
    })),
    threats: threats.map((t) => ({
      id: t.id,
      whyItMatters: t.knownRansomware
        ? `${t.cveIds[0] ?? t.title} is listed with known ransomware use — patch the public vendor product first.`
        : `${t.cveIds[0] ?? t.title} was added to the public KEV catalog and belongs on this week's patch board.`,
      severity: t.knownRansomware ? "critical" : "high",
    })),
  });
}

export async function summarizeSelected(opts: {
  posts: ContentItem[];
  threats: ContentItem[];
  provider: string;
  apiKey: string;
}): Promise<LlmOutput> {
  if (!opts.apiKey || opts.provider === "fixture") {
    return fixtureSummarize(opts.posts, opts.threats);
  }
  // Live LLM is intentionally not called without an explicit future adapter.
  return fixtureSummarize(opts.posts, opts.threats);
}

export function untrustedDataRegion(posts: ContentItem[], threats: ContentItem[]): string {
  const lines = [...posts, ...threats].map((i) => {
    return `<source id="${i.id}" url="${i.canonicalUrl}" cves="${i.cveIds.join(",")}">\nTITLE: ${i.title}\nEXCERPT: ${i.excerpt}\n</source>`;
  });
  return `<untrusted-data>\n${lines.join("\n")}\n</untrusted-data>`;
}
