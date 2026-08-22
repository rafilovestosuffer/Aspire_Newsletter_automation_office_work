import { readFileSync, existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import YAML from "yaml";
import { appRoot } from "./paths";
import type { AppConfig, ApproverConfig, BrandConfig, FeedConfig, RelevanceConfig, ScheduleConfig } from "./types";

const root = appRoot();

export function configRoot(): string {
  return root;
}

/** Directory that contains `issues/{encodedKey}/rN/`. */
export function artifactsRoot(artifactDir?: string): string {
  const raw = (artifactDir ?? "").trim();
  if (!raw) return join(root, "artifacts");
  return isAbsolute(raw) ? raw : join(root, raw);
}

/** Parse YAML documents used by config files and tests. */
export function parseMiniYaml(src: string): unknown {
  return YAML.parse(src) ?? {};
}

function readYaml<T>(name: string): T {
  const live = join(root, "config", `${name}.yaml`);
  const example = join(root, "config", `${name}.yaml.example`);
  const path = existsSync(live) ? live : example;
  return parseMiniYaml(readFileSync(path, "utf8")) as T;
}

export function loadConfig(): AppConfig {
  return {
    brand: readYaml<BrandConfig>("brand"),
    feeds: readYaml<FeedConfig>("feeds"),
    relevance: readYaml<RelevanceConfig>("relevance"),
    schedule: readYaml<ScheduleConfig>("schedule"),
    approvers: readYaml<ApproverConfig>("approvers"),
  };
}

export function allowHostsFromConfig(feeds: FeedConfig, brand: BrandConfig): Set<string> {
  const hosts = new Set<string>();
  hosts.add(feeds.cms.originHost.toLowerCase());
  for (const f of feeds.threatFeeds) hosts.add(f.allowHost.toLowerCase());
  for (const f of feeds.industryFeeds ?? []) hosts.add(f.allowHost.toLowerCase());
  for (const url of [brand.siteUrl, brand.logoUrl, brand.archiveBaseUrl, brand.unsubscribeUrl, brand.preferenceUrl]) {
    try {
      hosts.add(new URL(url).hostname.toLowerCase());
    } catch {
      /* TODO placeholders may be invalid until filled */
    }
  }
  if (brand.cdnHost) hosts.add(brand.cdnHost.toLowerCase());
  return hosts;
}
