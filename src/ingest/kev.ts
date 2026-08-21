import { sha256Hex } from "../domain/hash";
import { CONTENT_SCHEMA_VERSION, type ContentItem, type Severity } from "../types";
import { extractCves } from "./rss";
import { toSafeText } from "./sanitize";

interface KevDoc {
  vulnerabilities?: Array<{
    cveID?: string;
    vendorProject?: string;
    product?: string;
    vulnerabilityName?: string;
    dateAdded?: string;
    shortDescription?: string;
    knownRansomwareCampaignUse?: string;
  }>;
}

export function parseKevJson(raw: string, sourceId: string): ContentItem[] {
  const doc = JSON.parse(raw) as KevDoc;
  const out: ContentItem[] = [];
  for (const v of doc.vulnerabilities ?? []) {
    const cve = (v.cveID ?? "").toUpperCase();
    if (!/^CVE-\d{4}-\d{4,}$/.test(cve)) continue;
    const title = toSafeText(v.vulnerabilityName ?? cve);
    const excerpt = toSafeText(v.shortDescription ?? "");
    const dateAdded = v.dateAdded ?? "1970-01-01";
    const publishedAt = new Date(`${dateAdded}T00:00:00.000Z`).toISOString();
    const canonicalUrl = `https://www.cisa.gov/known-exploited-vulnerabilities-catalog?search=${encodeURIComponent(cve)}`;
    const vendorProduct = toSafeText(`${v.vendorProject ?? ""} ${v.product ?? ""}`.trim());
    const ransomware = (v.knownRansomwareCampaignUse ?? "").toLowerCase() === "known";
    out.push({
      schemaVersion: CONTENT_SCHEMA_VERSION,
      id: `threat:${cve}`,
      kind: "threat",
      sourceId,
      canonicalUrl,
      title,
      excerpt,
      publishedAt,
      cveIds: [...new Set([cve, ...extractCves(`${title} ${excerpt}`)])],
      rawHash: sha256Hex(JSON.stringify(v)),
      knownRansomware: ransomware,
      vendorProduct,
      severity: ransomware ? "critical" : ("high" as Severity),
    });
  }
  return out;
}
