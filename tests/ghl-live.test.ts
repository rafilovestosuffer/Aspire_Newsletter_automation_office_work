/**
 * The live HTTP transport.
 *
 * No test here reaches the network: each one stubs global fetch and asserts on
 * what the client *would* have sent. The point is that every guard still runs
 * before a request leaves, and that DRY_RUN never reaches the transport at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GhlBanError, GhlClient, GhlHttpError, type GhlEnv } from "../src/ghl/client";
import { readBindingLog } from "../src/ghl/binding";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function liveEnv(overrides: Partial<GhlEnv> = {}): GhlEnv {
  return {
    appEnv: "staging",
    dryRun: false,
    kill: { l1: false, l2: false },
    baseUrl: "https://services.leadconnectorhq.com",
    version: "v3",
    sandbox: { locationId: "loc-sb", userId: "user-sb", pit: "pit-sb" },
    production: { locationId: "loc-pr", userId: "user-pr", pit: "pit-pr" },
    bindingLogGreen: false,
    ...overrides,
  };
}

const createBody = {
  name: "aspire-UTC-2026-W34 r1",
  editorType: "html" as const,
  timeZone: "UTC",
  userId: "user-sb",
  editorContent: "<html><body>hi</body></html>",
};

const scheduleBody = {
  scheduleType: "scheduled" as const,
  timeZone: "UTC",
  userId: "user-sb",
  emailMeta: { subject: "s", fromName: "n", fromEmail: "n@mail.aspire.test" },
  recipients: { contactIds: ["seed-1"] },
};

/** Records calls and replies with a scripted sequence. */
function stubFetch(steps: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let n = 0;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const step = steps[Math.min(n, steps.length - 1)]!;
    n += 1;
    return new Response(JSON.stringify(step.body ?? {}), {
      status: step.status,
      headers: { "content-type": "application/json", ...(step.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
  return { calls, count: () => n };
}

describe("live transport: request shape", () => {
  it("sends the PIT as a bearer, the configured Version header, and JSON", async () => {
    const { calls } = stubFetch([{ status: 201, body: { id: "camp-1", status: "draft" } }]);
    const client = new GhlClient(liveEnv());

    const res = await client.createCampaign("sandbox", createBody);

    expect(res).toMatchObject({ id: "camp-1", dryRun: false });
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe(
      "https://services.leadconnectorhq.com/emails/locations/loc-sb/campaigns/emails",
    );
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer pit-sb");
    expect(headers.Version).toBe("v3");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(init.body))).toMatchObject({ editorType: "html" });
  });

  it("honours GHL_API_VERSION rather than hard-coding v3", async () => {
    const { calls } = stubFetch([{ status: 201, body: { id: "c" } }]);
    await new GhlClient(liveEnv({ version: "v2" })).createCampaign("sandbox", createBody);
    expect((calls[0]!.init.headers as Record<string, string>).Version).toBe("v2");
  });

  it("sends no body or content-type on the read path", async () => {
    const { calls } = stubFetch([{ status: 200, body: { id: "camp-1", status: "sent" } }]);
    const res = await new GhlClient(liveEnv()).getCampaign("sandbox", "camp-1");
    expect(res).toMatchObject({ id: "camp-1", status: "sent", dryRun: false });
    expect(calls[0]!.init.body).toBeUndefined();
    expect((calls[0]!.init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });

  it("surfaces the trace id, which is what a GHL support ticket needs", async () => {
    stubFetch([{ status: 201, body: { id: "c" }, headers: { "x-trace-id": "trace-abc" } }]);
    const res = await new GhlClient(liveEnv()).createCampaign("sandbox", createBody);
    expect(res.traceId).toBe("trace-abc");
  });
});

describe("live transport: guards run before the network", () => {
  // The whole safety model is that a refusal happens before a request leaves.
  // Asserting "it threw" is not enough — assert nothing was sent.
  it.each([
    ["rss schedule", (c: GhlClient) => c.scheduleCampaign("sandbox", "c1", { ...scheduleBody, scheduleType: "rss" })],
    ["builder editorType", (c: GhlClient) => c.createCampaign("sandbox", { ...createBody, editorType: "builder" as never })],
    ["recipients neither ids nor filter", (c: GhlClient) => c.scheduleCampaign("sandbox", "c1", { ...scheduleBody, recipients: {} as never })],
  ])("%s never reaches fetch", async (_label, call) => {
    const { count } = stubFetch([{ status: 201, body: { id: "c" } }]);
    await expect(call(new GhlClient(liveEnv()))).rejects.toBeInstanceOf(GhlBanError);
    expect(count()).toBe(0);
  });

  it("DRY_RUN short-circuits before any network call", async () => {
    const { count } = stubFetch([{ status: 201, body: { id: "c" } }]);
    const client = new GhlClient(liveEnv({ dryRun: true }));

    const created = await client.createCampaign("sandbox", createBody);
    const scheduled = await client.scheduleCampaign("sandbox", "c1", scheduleBody);
    const got = await client.getCampaign("sandbox", "c1");

    expect(created.dryRun).toBe(true);
    expect(scheduled.dryRun).toBe(true);
    expect(got.dryRun).toBe(true);
    expect(count()).toBe(0);
  });

  it("a missing PIT short-circuits rather than sending an unauthenticated request", async () => {
    const { count } = stubFetch([{ status: 201, body: { id: "c" } }]);
    const client = new GhlClient(liveEnv({ sandbox: { locationId: "l", userId: "u", pit: "" } }));
    expect((await client.createCampaign("sandbox", createBody)).dryRun).toBe(true);
    expect(count()).toBe(0);
  });

  it("refuses the production audience while the binding log is not green", async () => {
    const { count } = stubFetch([{ status: 201, body: { id: "c" } }]);
    const client = new GhlClient(liveEnv({ appEnv: "production", bindingLogGreen: false }));
    await expect(client.createCampaign("production", createBody)).rejects.toThrow(/UNVERIFIED/);
    expect(count()).toBe(0);
  });

  it("allows production once every gate including the binding log is open", async () => {
    const { calls } = stubFetch([{ status: 201, body: { id: "camp-prod" } }]);
    const client = new GhlClient(liveEnv({ appEnv: "production", bindingLogGreen: true }));
    const res = await client.createCampaign("production", { ...createBody, userId: "user-pr" });
    expect(res.id).toBe("camp-prod");
    expect(calls[0]!.url).toContain("loc-pr");
  });
});

describe("live transport: failures", () => {
  it("retries a 429 and then succeeds", async () => {
    const { count } = stubFetch([
      { status: 429, body: { message: "slow down" } },
      { status: 201, body: { id: "camp-1" } },
    ]);
    const res = await new GhlClient(liveEnv()).createCampaign("sandbox", createBody);
    expect(res.id).toBe("camp-1");
    expect(count()).toBe(2);
  });

  // A 400 means our payload is wrong. Repeating it burns rate limit and delays
  // the diagnosis; the schema will not change between attempts.
  it("does not retry a 400", async () => {
    const { count } = stubFetch([{ status: 400, body: { message: "bad emailMeta" } }]);
    await expect(
      new GhlClient(liveEnv()).createCampaign("sandbox", createBody),
    ).rejects.toBeInstanceOf(GhlHttpError);
    expect(count()).toBe(1);
  });

  it("does not retry a 401", async () => {
    const { count } = stubFetch([{ status: 401, body: { message: "bad token" } }]);
    await expect(new GhlClient(liveEnv()).createCampaign("sandbox", createBody)).rejects.toThrow();
    expect(count()).toBe(1);
  });

  it("gives up after a bounded number of attempts on repeated 5xx", async () => {
    const { count } = stubFetch([{ status: 503, body: { message: "unavailable" } }]);
    await expect(new GhlClient(liveEnv()).createCampaign("sandbox", createBody)).rejects.toThrow();
    expect(count()).toBe(3);
  });

  it("treats a 2xx with no campaign id as a failure, not a silent success", async () => {
    stubFetch([{ status: 201, body: { status: "draft" } }]);
    await expect(
      new GhlClient(liveEnv()).createCampaign("sandbox", createBody),
    ).rejects.toThrow(/no id/);
  });
});

describe("spike capture", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ghl-capture-"));
  });

  it("writes the request and response pair that the binding log needs", async () => {
    stubFetch([{ status: 201, body: { id: "camp-1", status: "draft" } }]);
    await new GhlClient(liveEnv({ captureDir: dir })).createCampaign("sandbox", createBody);

    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const doc = JSON.parse(readFileSync(join(dir, files[0]!), "utf8"));
    expect(doc.label).toBe("create-campaign");
    expect(doc.request.body.editorType).toBe("html");
    expect(doc.response.status).toBe(201);
    expect(doc.response.body.id).toBe("camp-1");
  });

  // Captures are committed as evidence, so a leaked PIT would be published.
  it("never writes the bearer token to disk", async () => {
    stubFetch([{ status: 201, body: { id: "camp-1" } }]);
    await new GhlClient(liveEnv({ captureDir: dir })).createCampaign("sandbox", createBody);

    const doc = readFileSync(join(dir, readdirSync(dir)[0]!), "utf8");
    expect(doc).not.toContain("pit-sb");
    expect(doc).not.toContain("Bearer");
  });

  it("captures failures too — a rejected payload is the useful evidence", async () => {
    stubFetch([{ status: 422, body: { message: "emailMeta.previewText not allowed" } }]);
    await expect(
      new GhlClient(liveEnv({ captureDir: dir })).createCampaign("sandbox", createBody),
    ).rejects.toThrow();

    const doc = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]!), "utf8"));
    expect(doc.response.status).toBe(422);
    expect(doc.response.body.message).toMatch(/previewText/);
  });

  it("stays silent when no capture directory is configured", async () => {
    stubFetch([{ status: 201, body: { id: "c" } }]);
    await new GhlClient(liveEnv()).createCampaign("sandbox", createBody);
    expect(readdirSync(dir)).toHaveLength(0);
  });
});

describe("binding log reader", () => {
  it("fails closed on a missing file", () => {
    expect(readBindingLog("/nope/BINDING-DECISIONS.md")).toMatchObject({ green: false });
  });

  it("counts only table rows, so prose about UNVERIFIED does not jam the gate", () => {
    const dir = mkdtempSync(join(tmpdir(), "binding-"));
    const path = join(dir, "log.md");

    writeFileSync(path, "# Log\n\nDo not mark a field UNVERIFIED without evidence.\n\n| a | VERIFIED-SPIKE |\n");
    expect(readBindingLog(path)).toMatchObject({ green: true, unverifiedCount: 0 });

    writeFileSync(path, "# Log\n\n| emailMeta | UNVERIFIED | |\n| filter | UNVERIFIED | |\n");
    expect(readBindingLog(path)).toMatchObject({ green: false, unverifiedCount: 2 });
  });
});
