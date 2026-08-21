import { describe, expect, it } from "vitest";
import { buildIssueKey, issueKeyFromPath, issueKeyToPath, parseIssueKey } from "../src/domain/issueKey";

const at = new Date("2026-08-20T19:00:00.000Z");

describe("issueKey", () => {
  it("uses audience IANA tz ISO week", () => {
    const key = buildIssueKey("aspire", "America/New_York", at);
    expect(key).toBe("aspire-America/New_York-2026-W34");
    expect(parseIssueKey(key)).toEqual({
      brandSlug: "aspire",
      audienceTz: "America/New_York",
      isoWeek: "2026-W34",
    });
    expect(issueKeyFromPath(issueKeyToPath(key))).toBe(key);
  });

  // Regression: the previous regex assumed exactly one slash in the zone, so
  // slash-less (UTC) and three-part (America/Argentina/...) audiences threw
  // "Malformed issueKey" at runtime — clockTick parses immediately after build.
  it.each([
    ["aspire", "UTC"],
    ["aspire", "America/New_York"],
    ["aspire", "Asia/Kolkata"],
    ["aspire", "Europe/London"],
    ["aspire", "America/Argentina/Buenos_Aires"],
    ["aspire", "America/Port-au-Prince"],
    ["aspire", "Etc/GMT+5"],
    ["aspire-tss", "UTC"],
    ["aspire-tss", "America/Argentina/Buenos_Aires"],
  ])("round-trips brand %s in zone %s", (brandSlug, audienceTz) => {
    const key = buildIssueKey(brandSlug, audienceTz, at);
    const parsed = parseIssueKey(key);
    expect(parsed.brandSlug).toBe(brandSlug);
    expect(parsed.audienceTz).toBe(audienceTz);
    expect(parsed.isoWeek).toMatch(/^\d{4}-W\d{2}$/);
    // Path encoding must survive multi-slash zones.
    expect(issueKeyFromPath(issueKeyToPath(key))).toBe(key);
    expect(issueKeyToPath(key)).not.toContain("/");
  });

  it("rejects a key with no ISO week suffix", () => {
    expect(() => parseIssueKey("aspire-America/New_York")).toThrow(/expected trailing/);
  });

  it("rejects a key whose middle segment is not a real IANA zone", () => {
    expect(() => parseIssueKey("aspire-Not/AZone-2026-W34")).toThrow(/no valid IANA timezone/);
  });

  it("refuses a brand slug containing a slash, which would corrupt path encoding", () => {
    expect(() => buildIssueKey("as/pire", "UTC", at)).toThrow(/must not contain/);
  });
});
