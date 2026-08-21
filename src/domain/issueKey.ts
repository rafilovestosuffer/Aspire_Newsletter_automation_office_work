import { DateTime } from "luxon";

export function isoWeekInZone(at: Date, timeZone: string): string {
  const dt = DateTime.fromJSDate(at, { zone: timeZone });
  if (!dt.isValid) {
    throw new Error(`Invalid audience timezone or date: ${timeZone} ${dt.invalidReason ?? ""}`);
  }
  const week = String(dt.weekNumber).padStart(2, "0");
  return `${dt.weekYear}-W${week}`;
}

export function buildIssueKey(brandSlug: string, audienceTz: string, at: Date): string {
  return `${brandSlug}-${audienceTz}-${isoWeekInZone(at, audienceTz)}`;
}

/** Fastify path segment cannot contain raw IANA slashes. */
export function issueKeyToPath(issueKey: string): string {
  return issueKey.replaceAll("/", "~");
}

export function issueKeyFromPath(issueKeyPath: string): string {
  return issueKeyPath.replaceAll("~", "/");
}

export function parseIssueKey(issueKey: string): { brandSlug: string; audienceTz: string; isoWeek: string } {
  const m = /^(.*?)-([A-Za-z_]+\/[A-Za-z_+\-]+)-(\d{4}-W\d{2})$/.exec(issueKey);
  if (!m || !m[1] || !m[2] || !m[3]) {
    throw new Error(`Malformed issueKey: ${issueKey}`);
  }
  return { brandSlug: m[1], audienceTz: m[2], isoWeek: m[3] };
}
