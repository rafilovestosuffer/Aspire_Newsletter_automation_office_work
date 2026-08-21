import { describe, expect, it } from "vitest";
import { GhlBanError, GhlClient, assertSandboxSpikeAllowed } from "../src/ghl/client";

function client(overrides: Partial<ConstructorParameters<typeof GhlClient>[0]> = {}) {
  return new GhlClient({
    appEnv: "development",
    dryRun: true,
    kill: { l1: false, l2: false },
    baseUrl: "https://services.leadconnectorhq.com",
    version: "v3",
    sandbox: { locationId: "sandbox-todo", userId: "user-todo", pit: "" },
    production: { locationId: "prod-todo", userId: "user-todo", pit: "" },
    ...overrides,
  });
}

describe("GHL adapter bans", () => {
  it("rejects scheduleType rss", async () => {
    const ghl = client();
    await expect(
      ghl.scheduleCampaign("sandbox", "c1", {
        scheduleType: "rss",
        timeZone: "America/New_York",
        userId: "u",
        emailMeta: { subject: "s", fromName: "n", fromEmail: "n@TODO.example.invalid" },
        recipients: { contactIds: ["seed"] },
      }),
    ).rejects.toBeInstanceOf(GhlBanError);
  });

  it("rejects conversations outbound paths", () => {
    const ghl = client();
    expect(() => ghl.assertNotForbiddenPath("/conversations/messages/outbound")).toThrow(GhlBanError);
  });

  it("refuses production audience unless gated", () => {
    const ghl = client({ appEnv: "development", dryRun: true });
    expect(() => ghl.assertAudienceSlot("production")).toThrow(/production audience/);
  });

  it("refuses the sandbox spike when APP_ENV=production", () => {
    expect(() => assertSandboxSpikeAllowed("production")).toThrow(/sandbox-only/);
    expect(() => assertSandboxSpikeAllowed("development")).not.toThrow();
  });

  it("rejects builder editorType", () => {
    const ghl = client();
    expect(() =>
      ghl.assertCreateBody({
        name: "x",
        editorType: "builder" as "html",
        timeZone: "America/New_York",
        userId: "u",
      }),
    ).toThrow(/html or text/);
  });
});
