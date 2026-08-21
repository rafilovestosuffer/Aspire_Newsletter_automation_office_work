import { DateTime, IANAZone } from "luxon";

export function isoWeekInZone(at: Date, timeZone: string): string {
  const dt = DateTime.fromJSDate(at, { zone: timeZone });
  if (!dt.isValid) {
    throw new Error(`Invalid audience timezone or date: ${timeZone} ${dt.invalidReason ?? ""}`);
  }
  const week = String(dt.weekNumber).padStart(2, "0");
  return `${dt.weekYear}-W${week}`;
}

export function buildIssueKey(brandSlug: string, audienceTz: string, at: Date): string {
  if (!brandSlug.trim()) {
    throw new Error("brandSlug is required to build an issueKey");
  }
  if (brandSlug.includes("/")) {
    throw new Error(`brandSlug must not contain "/": ${brandSlug}`);
  }
  return `${brandSlug}-${audienceTz}-${isoWeekInZone(at, audienceTz)}`;
}

/** Fastify path segment cannot contain raw IANA slashes. */
export function issueKeyToPath(issueKey: string): string {
  return issueKey.replaceAll("/", "~");
}

export function issueKeyFromPath(issueKeyPath: string): string {
  return issueKeyPath.replaceAll("~", "/");
}

const ISO_WEEK_SUFFIX = /-(\d{4}-W\d{2})$/;

/**
 * Split `{brandSlug}-{audienceTz}-{isoWeek}`.
 *
 * Both halves of the prefix may contain hyphens (brand `aspire-tss`, zone
 * `America/Port-au-Prince`) and the zone may contain zero, one, or two slashes
 * (`UTC`, `America/New_York`, `America/Argentina/Buenos_Aires`). So rather than
 * assuming a shape, anchor on the fixed ISO-week suffix and take the first
 * boundary whose right-hand side is a real IANA zone.
 */
export function parseIssueKey(issueKey: string): { brandSlug: string; audienceTz: string; isoWeek: string } {
  const weekMatch = ISO_WEEK_SUFFIX.exec(issueKey);
  if (!weekMatch?.[1]) {
    throw new Error(`Malformed issueKey (expected trailing -YYYY-Www): ${issueKey}`);
  }
  const isoWeek = weekMatch[1];
  const prefix = issueKey.slice(0, weekMatch.index);

  for (let i = prefix.indexOf("-"); i !== -1; i = prefix.indexOf("-", i + 1)) {
    const brandSlug = prefix.slice(0, i);
    const audienceTz = prefix.slice(i + 1);
    if (brandSlug && audienceTz && IANAZone.isValidZone(audienceTz)) {
      return { brandSlug, audienceTz, isoWeek };
    }
  }
  throw new Error(`Malformed issueKey (no valid IANA timezone): ${issueKey}`);
}
