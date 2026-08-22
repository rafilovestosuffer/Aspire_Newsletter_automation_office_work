import type { ContentItem, RelevanceConfig } from "../types";

export interface Selection {
  posts: ContentItem[];
  threats: ContentItem[];
  briefs: ContentItem[];
}

function recencyWeight(publishedAt: string, now: Date, lookbackDays: number): number {
  const ageDays = (now.getTime() - Date.parse(publishedAt)) / 86_400_000;
  if (ageDays < 0) return 1;
  if (ageDays > lookbackDays) return 0;
  return Math.max(0, 1 - ageDays / lookbackDays);
}

export function scoreItem(item: ContentItem, now: Date, cfg: RelevanceConfig): number {
  const recency = recencyWeight(item.publishedAt, now, cfg.postLookbackDays);
  let score = recency * 40;
  if (item.kind === "threat") score += 20;
  if (item.knownRansomware) score += 25;
  const hay = `${item.title} ${item.excerpt} ${item.vendorProduct ?? ""}`.toLowerCase();
  for (const kw of cfg.keywords) {
    if (kw && hay.includes(kw.toLowerCase())) score += 10;
  }
  return score;
}

/**
 * Ransomware-linked first, then nearest CISA remediation deadline, then score.
 * This is how the audience actually triages a patch board — the practitioner
 * framing is "when a CVE appears in KEV, its due date becomes your SLA" — so
 * selection order should match that rather than pure recency/keyword score.
 */
function threatUrgency(a: ContentItem, b: ContentItem): number {
  const ra = a.knownRansomware ? 1 : 0;
  const rb = b.knownRansomware ? 1 : 0;
  if (ra !== rb) return rb - ra;
  const da = a.dueDate ? Date.parse(a.dueDate) : Infinity;
  const db = b.dueDate ? Date.parse(b.dueDate) : Infinity;
  if (da !== db) return da - db;
  return 0;
}

export function selectContent(items: ContentItem[], now: Date, cfg: RelevanceConfig): Selection {
  const horizon = now.getTime() - cfg.postLookbackDays * 86_400_000;
  const posts = items
    .filter((i) => i.kind === "post" && Date.parse(i.publishedAt) >= horizon)
    .map((i) => ({ ...i, score: scoreItem(i, now, cfg) }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, cfg.postCap);

  const threats = items
    .filter((i) => i.kind === "threat" && Date.parse(i.publishedAt) >= horizon)
    .map((i) => ({ ...i, score: scoreItem(i, now, cfg) }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, cfg.threatCap)
    .sort(threatUrgency);

  const briefs = items
    .filter((i) => i.kind === "brief" && Date.parse(i.publishedAt) >= horizon)
    .map((i) => ({ ...i, score: scoreItem(i, now, cfg) }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, cfg.briefCap);

  return { posts, threats, briefs };
}
