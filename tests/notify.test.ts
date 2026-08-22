import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { loadEnv } from "../src/env";
import { notifyStaff, type NotifyDeps, type StaffNotification } from "../src/services/notify";
import { MemoryStore } from "../src/store/memory";
import { clockTick, ingestFixtures, assembleIssue, requestApproval } from "../src/services/control";

function testEnv(overrides: Record<string, string> = {}) {
  return loadEnv({
    APP_ENV: "development",
    DRY_RUN: "true",
    FIXTURE_MODE: "true",
    ALLOW_TOKEN_ECHO: "1",
    APP_SECRET: "test-secret-at-least-32-bytes-long",
    WORKER_TOKEN: "test-worker",
    PUBLIC_BASE_URL: "http://localhost:8787",
    ...overrides,
  });
}

const configuredEnv = (extra: Record<string, string> = {}) =>
  testEnv({
    STAFF_NOTIFY_SMTP_URL: "smtps://user:pass@smtp.aspire.test:465",
    STAFF_NOTIFY_FROM: "control-plane@ops.aspire.test",
    STAFF_NOTIFY_TO: "approvers@ops.aspire.test",
    ...extra,
  });

const note: StaffNotification = {
  event: "approval_requested",
  issueKey: "aspire-UTC-2026-W34",
  revision: 1,
  subject: "This week's issue",
  urls: [{ approverId: "approver-primary", url: "http://localhost:8787/approve/x/r/1?t=abc" }],
};

/** Records what would have been sent; never opens a socket. */
function spyDeps() {
  const mails: Array<Record<string, string>> = [];
  const hooks: Array<{ url: string; body: unknown }> = [];
  const deps: NotifyDeps = {
    sendMail: async (o) => {
      mails.push(o as unknown as Record<string, string>);
    },
    postWebhook: async (url, body) => {
      hooks.push({ url, body });
    },
  };
  return { deps, mails, hooks };
}

describe("staff notification sinks", () => {
  it("does nothing and says so when neither sink is configured", async () => {
    const { deps, mails, hooks } = spyDeps();
    const res = await notifyStaff(testEnv(), note, undefined, deps);
    expect(res).toMatchObject({ webhook: "not_configured", email: "not_configured", errors: [] });
    expect(mails).toHaveLength(0);
    expect(hooks).toHaveLength(0);
  });

  it("sends both sinks when both are configured", async () => {
    const { deps, mails, hooks } = spyDeps();
    const env = configuredEnv({ STAFF_NOTIFY_WEBHOOK: "https://hooks.aspire.test/staff" });

    const res = await notifyStaff(env, note, undefined, deps);

    expect(res).toMatchObject({ webhook: "sent", email: "sent", errors: [] });
    expect(hooks[0]!.url).toBe("https://hooks.aspire.test/staff");
    expect(mails[0]!.to).toBe("approvers@ops.aspire.test");
    expect(mails[0]!.from).toBe("control-plane@ops.aspire.test");
  });

  it("puts the approval link in the mail and says plainly that opening it does not send", async () => {
    const { deps, mails } = spyDeps();
    await notifyStaff(configuredEnv(), note, undefined, deps);

    const mail = mails[0]!;
    expect(mail.subject).toContain("approval needed");
    expect(mail.text).toContain(note.urls![0]!.url);
    expect(mail.html).toContain(note.urls![0]!.url);
    // Approvers act on this mail; the inert-GET property is worth stating where
    // they will read it, not only in the runbook.
    expect(mail.text).toMatch(/does NOT send/);
    expect(mail.html).toMatch(/does not send/i);
  });

  it("escapes untrusted text in the HTML part", async () => {
    const { deps, mails } = spyDeps();
    await notifyStaff(
      configuredEnv(),
      { ...note, subject: '<img src=x onerror="alert(1)">' },
      undefined,
      deps,
    );
    const html = mails[0]!.html!;
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("labels each event with a subject an on-call person can triage", async () => {
    const { deps, mails } = spyDeps();
    const env = configuredEnv();
    await notifyStaff(env, { ...note, event: "approval_overdue" }, undefined, deps);
    await notifyStaff(env, { ...note, event: "outbox_dead_letter" }, undefined, deps);

    expect(mails[0]!.subject).toContain("OVERDUE");
    expect(mails[1]!.subject).toContain("FAILED");
  });
});

describe("on-call escalation", () => {
  // A separate sink so the watchdog can page someone for a stuck approval
  // without every routine "approval requested" doing the same.
  it("does not page on-call for a routine notification", async () => {
    const { deps, hooks } = spyDeps();
    const env = configuredEnv({ ONCALL_WEBHOOK_URL: "https://pager.aspire.test/hook" });

    const res = await notifyStaff(env, note, undefined, deps);

    expect(res.oncall).toBe("not_urgent");
    expect(hooks).toHaveLength(0);
  });

  it("pages on-call for an urgent one, tagged so the pager can route it", async () => {
    const { deps, hooks } = spyDeps();
    const env = configuredEnv({ ONCALL_WEBHOOK_URL: "https://pager.aspire.test/hook" });

    const res = await notifyStaff(env, { ...note, event: "approval_overdue", urgent: true }, undefined, deps);

    expect(res.oncall).toBe("sent");
    expect(hooks[0]!.url).toBe("https://pager.aspire.test/hook");
    expect(hooks[0]!.body).toMatchObject({ severity: "urgent", event: "approval_overdue" });
  });

  it("reports a failed page rather than throwing", async () => {
    const deps: NotifyDeps = {
      sendMail: async () => {},
      postWebhook: async () => {
        throw new Error("pager 503");
      },
    };
    const env = configuredEnv({ ONCALL_WEBHOOK_URL: "https://pager.aspire.test/hook" });
    const res = await notifyStaff(env, { ...note, urgent: true }, undefined, deps);
    expect(res.oncall).toBe("failed");
    expect(res.errors.join(" ")).toMatch(/pager 503/);
  });
});

describe("staff notification failures", () => {
  // The approval token is already minted and valid by the time we notify.
  // Throwing here would strand it and fail the whole request for a reason the
  // approver cannot act on.
  it("never throws when a sink fails, and reports which one", async () => {
    const deps: NotifyDeps = {
      sendMail: async () => {
        throw new Error("smtp refused connection");
      },
      postWebhook: async () => {
        throw new Error("502 bad gateway");
      },
    };
    const env = configuredEnv({ STAFF_NOTIFY_WEBHOOK: "https://hooks.aspire.test/staff" });

    const res = await notifyStaff(env, note, undefined, deps);

    expect(res.webhook).toBe("failed");
    expect(res.email).toBe("failed");
    expect(res.errors.join(" ")).toMatch(/smtp refused/);
    expect(res.errors.join(" ")).toMatch(/502/);
  });

  it("records the outcome in issue_events rather than letting it vanish", async () => {
    const store = new MemoryStore();
    const deps: NotifyDeps = {
      sendMail: async () => {
        throw new Error("smtp refused connection");
      },
    };

    await notifyStaff(configuredEnv(), note, store, deps);

    const ev = store.events.find((e) => e.eventType === "notify_failed");
    expect(ev).toBeTruthy();
    expect(JSON.stringify(ev!.payload)).toMatch(/smtp refused/);
  });

  it("records a success event too, so silence means nothing was attempted", async () => {
    const store = new MemoryStore();
    const { deps } = spyDeps();
    await notifyStaff(configuredEnv(), note, store, deps);
    expect(store.events.some((e) => e.eventType === "notify_sent")).toBe(true);
  });

  // Half-configured email is a deployment mistake. Treating it as "not
  // configured" would silently drop approval mail on a host that plainly meant
  // to send it.
  it.each([
    ["missing recipient", { STAFF_NOTIFY_TO: "" }],
    ["missing sender", { STAFF_NOTIFY_FROM: "" }],
    ["missing smtp url", { STAFF_NOTIFY_SMTP_URL: "" }],
  ])("treats %s as a failure, not as opting out", async (_label, patch) => {
    const { deps, mails } = spyDeps();
    const res = await notifyStaff(configuredEnv(patch), note, undefined, deps);
    expect(res.email).toBe("failed");
    expect(res.errors.join(" ")).toMatch(/must all be set/);
    expect(mails).toHaveLength(0);
  });
});

describe("approval request still succeeds when notification is broken", () => {
  it("mints and persists tokens even though every sink fails", async () => {
    const env = configuredEnv({
      APP_ENV: "development",
      ALLOW_TOKEN_ECHO: "1",
      STAFF_NOTIFY_SMTP_URL: "smtps://nobody@127.0.0.1:1",
    });
    const config = loadConfig();
    const store = new MemoryStore();
    const now = new Date("2026-08-20T19:00:00.000Z");

    const tick = await clockTick({ store, env, config, now });
    await ingestFixtures(store, config);
    await assembleIssue({ store, env, config, issueKey: tick.issueKey, now });

    // Real notify path: SMTP points at a closed port, so the send genuinely
    // fails rather than being stubbed out.
    const minted = await requestApproval({ store, env, config, issueKey: tick.issueKey });

    expect(minted.issued).toBeGreaterThan(0);
    expect((await store.getIssue(tick.issueKey))?.status).toBe("pending_approval");
    expect(store.tokens.size).toBeGreaterThan(0);
    expect(store.events.some((e) => e.eventType === "notify_failed")).toBe(true);
  }, 30_000);
});
