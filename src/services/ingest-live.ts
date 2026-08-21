import type { AppConfig } from "../types";
import type { IssueStore } from "../store/types";
import { allowHostsFromConfig } from "../config";
import { parseRssPosts } from "../ingest/rss";
import { parseKevJson } from "../ingest/kev";
import { safeFetch } from "../ingest/ssrf";

export function isPlaceholderHost(host: string): boolean {
  const h = host.toLowerCase();
  return h.includes("example.invalid") || h.startsWith("todo.") || h.includes("todo-");
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Live allowlisted fetch. Never hits TODO.example.invalid placeholder hosts. */
export async function ingestLive(
  store: IssueStore,
  config: AppConfig,
  opts?: { fetchImpl?: typeof fetch },
): Promise<{ upserted: number; skipped: string[]; errors: string[] }> {
  const allow = allowHostsFromConfig(config.feeds, config.brand);
  const skipped: string[] = [];
  const errors: string[] = [];
  let upserted = 0;

  async function ingestUrl(id: string, url: string, kind: "rss" | "kev-json"): Promise<void> {
    const host = hostOf(url);
    if (!host || isPlaceholderHost(host)) {
      skipped.push(id);
      return;
    }
    try {
      const res = await safeFetch(url, { allowHosts: allow, fetchImpl: opts?.fetchImpl });
      const text = res.body.toString("utf8");
      const items = kind === "kev-json" ? parseKevJson(text, id) : parseRssPosts(text, id);
      for (const item of items) await store.upsertContent(item);
      upserted += items.length;
    } catch (err) {
      errors.push(`${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await ingestUrl("cms", config.feeds.cms.rssUrl, "rss");
  for (const feed of config.feeds.threatFeeds) {
    await ingestUrl(feed.id, feed.url, feed.kind === "kev-json" ? "kev-json" : "rss");
  }
  return { upserted, skipped, errors };
}
