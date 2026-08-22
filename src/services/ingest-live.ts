import type { AppConfig, IngestScope } from "../types";
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

export interface LiveIngestResult {
  upserted: number;
  skipped: string[];
  errors: string[];
  scope: IngestScope;
}

/**
 * Live allowlisted fetch. Never hits TODO.example.invalid placeholder hosts.
 *
 * `scope` decides which half of the feed registry runs: the CMS feed
 * ("posts"), the threat feeds ("threats"), or both ("all"). Workflows 02 and
 * 03 pass distinct scopes so they no longer duplicate each other's work.
 */
export async function ingestLive(
  store: IssueStore,
  config: AppConfig,
  opts?: { fetchImpl?: typeof fetch; scope?: IngestScope },
): Promise<LiveIngestResult> {
  const scope = opts?.scope ?? "all";
  const allow = allowHostsFromConfig(config.feeds, config.brand);
  const skipped: string[] = [];
  const errors: string[] = [];
  let upserted = 0;

  async function ingestUrl(id: string, url: string, kind: "rss" | "kev-json" | "brief"): Promise<void> {
    const host = hostOf(url);
    if (!host || isPlaceholderHost(host)) {
      skipped.push(id);
      return;
    }
    try {
      const res = await safeFetch(url, { allowHosts: allow, fetchImpl: opts?.fetchImpl });
      const text = res.body.toString("utf8");
      const items =
        kind === "kev-json" ? parseKevJson(text, id) : parseRssPosts(text, id, kind === "brief" ? "brief" : "post");
      for (const item of items) await store.upsertContent(item);
      upserted += items.length;
    } catch (err) {
      errors.push(`${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (scope === "posts" || scope === "all") {
    await ingestUrl("cms", config.feeds.cms.rssUrl, "rss");
  }
  if (scope === "threats" || scope === "all") {
    for (const feed of config.feeds.threatFeeds) {
      await ingestUrl(feed.id, feed.url, feed.kind === "kev-json" ? "kev-json" : "rss");
    }
  }
  if (scope === "briefs" || scope === "all") {
    for (const feed of config.feeds.industryFeeds ?? []) {
      await ingestUrl(feed.id, feed.url, "brief");
    }
  }
  return { upserted, skipped, errors, scope };
}
