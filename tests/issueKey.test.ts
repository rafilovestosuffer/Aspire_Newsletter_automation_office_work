import { describe, expect, it } from "vitest";
import { buildIssueKey, issueKeyFromPath, issueKeyToPath, parseIssueKey } from "../src/domain/issueKey";

describe("issueKey", () => {
  it("uses audience IANA tz ISO week", () => {
    const key = buildIssueKey("aspire", "America/New_York", new Date("2026-08-20T19:00:00.000Z"));
    expect(key).toBe("aspire-America/New_York-2026-W34");
    expect(parseIssueKey(key)).toEqual({
      brandSlug: "aspire",
      audienceTz: "America/New_York",
      isoWeek: "2026-W34",
    });
    expect(issueKeyFromPath(issueKeyToPath(key))).toBe(key);
  });
});
