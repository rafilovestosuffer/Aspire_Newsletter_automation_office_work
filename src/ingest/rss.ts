import { XMLParser } from "fast-xml-parser";
import { sha256Hex } from "../domain/hash";
import { CONTENT_SCHEMA_VERSION, type ContentItem } from "../types";
import { isHttpUrl, toSafeText } from "./sanitize";

const parser = new XMLParser({
  ignoreAttributes: false,
  cdataPropName: "__cdata",
  trimValues: true,
});

function textOf(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.__cdata === "string") return o.__cdata;
    if (typeof o["#text"] === "string") return o["#text"];
  }
  return String(v);
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

export function parseRssPosts(xml: string, sourceId: string): ContentItem[] {
  const doc = parser.parse(xml) as { rss?: { channel?: { item?: unknown } } };
  const items = asArray(doc.rss?.channel?.item as Record<string, unknown> | Record<string, unknown>[] | undefined);
  const out: ContentItem[] = [];
  for (const item of items) {
    const title = toSafeText(textOf(item.title));
    const excerpt = toSafeText(textOf(item.description ?? item.summary ?? ""));
    const link = textOf(item.link ?? item.guid).trim();
    if (!isHttpUrl(link)) continue;
    const pub = textOf(item.pubDate ?? item.published ?? "");
    const publishedAt = pub ? new Date(pub).toISOString() : new Date(0).toISOString();
    if (Number.isNaN(Date.parse(publishedAt))) continue;
    const rawHash = sha256Hex(`${link}\n${title}\n${excerpt}`);
    out.push({
      schemaVersion: CONTENT_SCHEMA_VERSION,
      id: `post:${sha256Hex(link).slice(0, 16)}`,
      kind: "post",
      sourceId,
      canonicalUrl: link,
      title,
      excerpt,
      publishedAt,
      cveIds: extractCves(`${title} ${excerpt}`),
      rawHash,
    });
  }
  return out;
}

export function extractCves(text: string): string[] {
  const matches = text.toUpperCase().match(/CVE-\d{4}-\d{4,}/g) ?? [];
  return [...new Set(matches)];
}
