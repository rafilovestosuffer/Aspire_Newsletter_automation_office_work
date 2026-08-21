import nodemailer from "nodemailer";
import type { Env } from "../env";
import type { IssueStore } from "../store/types";
import { escapeHtml } from "../render/compile";

/**
 * Staff notification. Never a subscriber send.
 *
 * Two sinks, both optional and both best-effort: a webhook, and transactional
 * email. Email is deliberately **not** LC Email — that is the list channel, and
 * putting operational mail on the marketing domain puts its sending reputation
 * at risk for no benefit. Any provider that speaks SMTP works, so this stays
 * vendor-neutral.
 *
 * A sink that fails must not break assemble or approval: the approval token is
 * already minted and valid, and failing the request would strand it. But a
 * failure that vanishes silently is how nobody notices approvals stopped
 * arriving, so every outcome is written to `issue_events`.
 */

export interface StaffNotification {
  event: string;
  issueKey: string;
  revision?: number;
  subject?: string;
  note?: string;
  urls?: Array<{ approverId: string; url: string }>;
}

export interface NotifyResult {
  webhook: "sent" | "failed" | "not_configured";
  email: "sent" | "failed" | "not_configured";
  errors: string[];
}

/** Injectable so tests never open a socket. */
export interface NotifyDeps {
  sendMail?: (opts: {
    smtpUrl: string;
    from: string;
    to: string;
    subject: string;
    text: string;
    html: string;
  }) => Promise<void>;
  postWebhook?: (url: string, body: unknown) => Promise<void>;
}

async function defaultPostWebhook(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`webhook responded ${res.status}`);
}

async function defaultSendMail(opts: {
  smtpUrl: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<void> {
  const transport = nodemailer.createTransport(opts.smtpUrl, {
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  try {
    await transport.sendMail({
      from: opts.from,
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
    });
  } finally {
    transport.close();
  }
}

function subjectLine(n: StaffNotification): string {
  const rev = n.revision === undefined ? "" : ` r${n.revision}`;
  switch (n.event) {
    case "approval_requested":
      return `[approval needed] ${n.issueKey}${rev}`;
    case "approval_overdue":
      return `[OVERDUE] approval past SLA — ${n.issueKey}${rev}`;
    case "outbox_dead_letter":
      return `[FAILED] outbox gave up — ${n.issueKey}${rev}`;
    default:
      return `[${n.event}] ${n.issueKey}${rev}`;
  }
}

function renderText(n: StaffNotification): string {
  const lines = [
    subjectLine(n),
    "",
    `Issue:    ${n.issueKey}`,
    n.revision === undefined ? "" : `Revision: ${n.revision}`,
    n.subject ? `Subject:  ${n.subject}` : "",
    n.note ? `Note:     ${n.note}` : "",
  ].filter(Boolean);

  if (n.urls?.length) {
    lines.push("", "Approval links (one per approver):");
    for (const u of n.urls) lines.push(`  ${u.approverId}: ${u.url}`);
    lines.push(
      "",
      "Opening a link does NOT send. The page shows the frozen issue and a",
      "button; only submitting that button sends. Each link works once.",
    );
  }
  return lines.join("\n");
}

function renderHtml(n: StaffNotification): string {
  const rows = [
    ["Issue", n.issueKey],
    n.revision === undefined ? null : ["Revision", String(n.revision)],
    n.subject ? ["Subject", n.subject] : null,
    n.note ? ["Note", n.note] : null,
  ].filter(Boolean) as Array<[string, string]>;

  const table = rows
    .map(([k, v]) => `<tr><td><strong>${escapeHtml(k)}</strong></td><td>${escapeHtml(v)}</td></tr>`)
    .join("");

  const links = n.urls?.length
    ? `<p>Approval links (one per approver):</p><ul>${n.urls
        .map(
          (u) =>
            `<li>${escapeHtml(u.approverId)}: <a href="${escapeHtml(u.url)}">${escapeHtml(u.url)}</a></li>`,
        )
        .join("")}</ul>
       <p><em>Opening a link does not send.</em> The page shows the frozen issue
       and a button; only submitting that button sends. Each link works once.</p>`
    : "";

  return `<h2>${escapeHtml(subjectLine(n))}</h2><table>${table}</table>${links}`;
}

export async function notifyStaff(
  env: Env,
  payload: StaffNotification,
  store?: IssueStore,
  deps: NotifyDeps = {},
): Promise<NotifyResult> {
  const result: NotifyResult = { webhook: "not_configured", email: "not_configured", errors: [] };
  const postWebhook = deps.postWebhook ?? defaultPostWebhook;
  const sendMail = deps.sendMail ?? defaultSendMail;

  const webhookUrl = env.STAFF_NOTIFY_WEBHOOK.trim();
  if (webhookUrl) {
    try {
      await postWebhook(webhookUrl, { source: "e02-control-plane", ...payload });
      result.webhook = "sent";
    } catch (err) {
      result.webhook = "failed";
      result.errors.push(`webhook: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const smtpUrl = env.STAFF_NOTIFY_SMTP_URL.trim();
  const from = env.STAFF_NOTIFY_FROM.trim();
  const to = env.STAFF_NOTIFY_TO.trim();
  if (smtpUrl && from && to) {
    try {
      await sendMail({
        smtpUrl,
        from,
        to,
        subject: subjectLine(payload),
        text: renderText(payload),
        html: renderHtml(payload),
      });
      result.email = "sent";
    } catch (err) {
      result.email = "failed";
      result.errors.push(`email: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (smtpUrl || from || to) {
    // Half-configured is a misconfiguration, not a decision to skip email.
    result.email = "failed";
    result.errors.push(
      "email: STAFF_NOTIFY_SMTP_URL, STAFF_NOTIFY_FROM and STAFF_NOTIFY_TO must all be set",
    );
  }

  // The audit trail is the point: a notification that silently stopped working
  // is indistinguishable from one nobody needed.
  if (store) {
    await store.appendEvent({
      issueKey: payload.issueKey,
      revision: payload.revision,
      eventType: result.errors.length ? "notify_failed" : "notify_sent",
      payload: { event: payload.event, webhook: result.webhook, email: result.email, errors: result.errors },
    });
  }

  return result;
}
