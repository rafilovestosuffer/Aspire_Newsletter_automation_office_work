import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "../env";
import type { AppConfig, ApprovalAction, ContentItem, IngestScope } from "../types";
import { ISSUE_SCHEMA_VERSION, TERMINAL_NOOP_STATUSES } from "../types";
import { archiveSig, csrfForToken, randomTokenHex, sha256Hex, uuidV4 } from "../domain/hash";
import { buildIssueKey, issueKeyToPath, parseIssueKey } from "../domain/issueKey";
import { dualControlRequired, envKill, mergeKill, outboxIdempotencyKey } from "../domain/policy";
import type { IssueStore } from "../store/types";
import type { IssueRow } from "../store/types";
import { assembleFromItems, loadFrozenHtml } from "../assemble/pipeline";
import { parseRssPosts } from "../ingest/rss";
import { parseKevJson } from "../ingest/kev";
import { GhlClient } from "../ghl/client";
import { resolveDrainRecipients } from "../ghl/audience";
import { TwentyClient } from "../twenty/client";
import { artifactsRoot, configRoot } from "../config";
import { ingestLive } from "./ingest-live";
import { notifyStaff } from "./notify";

const TOKEN_TTL_MS = 48 * 60 * 60 * 1000;

export function combinedKill(env: Env, db: { l1: boolean; l2: boolean }) {
  return mergeKill(envKill(env.KILL_SWITCH, env.KILL_OUTBOX), db);
}

export interface OpenIssueResult {
  issueKey: string;
  status: string;
  noOpReason?: string;
}

/**
 * Open (or no-op on) one specific issue under its advisory lock.
 *
 * Shared by the scheduled clock and by an operator collecting a named week, so
 * both paths get identical kill, skip-week, terminal-status and idempotency
 * behaviour rather than the clock owning it exclusively.
 */
export async function openIssue(opts: {
  store: IssueStore;
  env: Env;
  config: AppConfig;
  issueKey: string;
  actor: string;
}): Promise<OpenIssueResult> {
  const kill = combinedKill(opts.env, await opts.store.getKill());
  if (kill.l1) {
    return { issueKey: opts.issueKey, status: "noop", noOpReason: "KILL_SWITCH L1" };
  }
  const parsed = parseIssueKey(opts.issueKey);
  if (opts.config.schedule.skipWeeks.includes(parsed.isoWeek)) {
    return { issueKey: opts.issueKey, status: "skipped", noOpReason: "skipWeeks" };
  }
  return opts.store.withIssueLock(opts.issueKey, async () => {
    const existing = await opts.store.getIssue(opts.issueKey);
    if (existing && TERMINAL_NOOP_STATUSES.has(existing.status)) {
      return { issueKey: opts.issueKey, status: existing.status, noOpReason: "already terminal" };
    }
    if (!existing) {
      const row: IssueRow = {
        schemaVersion: ISSUE_SCHEMA_VERSION,
        id: uuidV4(),
        issueKey: opts.issueKey,
        brandSlug: parsed.brandSlug,
        audienceTz: parsed.audienceTz,
        isoWeek: parsed.isoWeek,
        revision: 1,
        status: "collecting",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await opts.store.insertIssue(row);
      await opts.store.appendEvent({
        issueKey: opts.issueKey,
        revision: 1,
        eventType: "collect_opened",
        actor: opts.actor,
      });
      return { issueKey: opts.issueKey, status: "collecting" };
    }
    return { issueKey: opts.issueKey, status: existing.status };
  });
}

/** Scheduled entry point: derives this week's issueKey from `now`. */
export async function clockTick(opts: {
  store: IssueStore;
  env: Env;
  config: AppConfig;
  now: Date;
}): Promise<OpenIssueResult> {
  const issueKey = buildIssueKey(opts.config.brand.slug, opts.config.schedule.audienceTimeZone, opts.now);
  return openIssue({ ...opts, issueKey, actor: "clock" });
}

/**
 * Operator entry point: collect the issue named in the request path, which may
 * be a past week being re-run. Previously this ignored its own issueKey and
 * silently collected whatever week "now" happened to fall in.
 */
export async function collectIssue(opts: {
  store: IssueStore;
  env: Env;
  config: AppConfig;
  issueKey: string;
}): Promise<OpenIssueResult> {
  try {
    parseIssueKey(opts.issueKey);
  } catch (err) {
    throw Object.assign(new Error(err instanceof Error ? err.message : String(err)), { statusCode: 400 });
  }
  return openIssue({ ...opts, actor: "operator" });
}

export function loadFixtureItems(_config: AppConfig, scope: IngestScope = "all"): ContentItem[] {
  const root = configRoot();
  const items: ContentItem[] = [];
  if (scope === "posts" || scope === "all") {
    items.push(...parseRssPosts(readFileSync(join(root, "fixtures/posts.rss"), "utf8"), "fixture-cms"));
  }
  if (scope === "threats" || scope === "all") {
    items.push(...parseKevJson(readFileSync(join(root, "fixtures/kev.json"), "utf8"), "cisa-kev"));
  }
  return items;
}

export async function ingestFixtures(
  store: IssueStore,
  config: AppConfig,
  scope: IngestScope = "all",
): Promise<number> {
  const items = loadFixtureItems(config, scope);
  for (const item of items) await store.upsertContent(item);
  return items.length;
}

export interface IngestOutcome {
  upserted: number;
  source: "fixtures" | "live";
  scope: IngestScope;
  skipped?: string[];
  errors?: string[];
}

/**
 * Single ingest entry point for the worker routes. `scope` selects the CMS
 * half or the threat half so ingest-posts and ingest-threats do distinct work.
 */
export async function ingestContent(opts: {
  store: IssueStore;
  env: Env;
  config: AppConfig;
  scope: IngestScope;
  forceFixture?: boolean;
}): Promise<IngestOutcome> {
  if (opts.env.fixtureMode || opts.forceFixture) {
    const upserted = await ingestFixtures(opts.store, opts.config, opts.scope);
    return { upserted, source: "fixtures", scope: opts.scope };
  }
  const live = await ingestLive(opts.store, opts.config, { scope: opts.scope });
  return { ...live, source: "live" };
}

export async function assembleIssue(opts: {
  store: IssueStore;
  env: Env;
  config: AppConfig;
  issueKey: string;
  now: Date;
}): Promise<{ issueKey: string; revision: number; status: string; qa: unknown }> {
  return opts.store.withIssueLock(opts.issueKey, async () => {
    const existing = await opts.store.getIssue(opts.issueKey);
    if (!existing) throw Object.assign(new Error("issue not found"), { statusCode: 404 });
    if (TERMINAL_NOOP_STATUSES.has(existing.status)) {
      return { issueKey: opts.issueKey, revision: existing.revision, status: existing.status, qa: { ok: true, noOp: true } };
    }
    const revision =
      existing.status === "rejected" || existing.status === "qa_failed" ? existing.revision + 1 : existing.revision;
    const items = await opts.store.listContent();
    const result = await assembleFromItems({
      issue: { ...existing, revision },
      items,
      config: opts.config,
      now: opts.now,
      artifactsRoot: artifactsRoot(opts.env.ARTIFACT_DIR),
      publicBaseUrl: opts.env.PUBLIC_BASE_URL,
      llmProvider: opts.env.LLM_PROVIDER,
      llmApiKey: opts.env.LLM_API_KEY ?? "",
    });
    await opts.store.updateIssue(opts.issueKey, {
      revision,
      status: result.issue.status,
      subject: result.issue.subject,
      preheader: result.issue.preheader,
      htmlSha256: result.issue.htmlSha256,
      textSha256: result.issue.textSha256,
      freezeJson: { postIds: result.issue.postIds, threatIds: result.issue.threatIds, llm: result.llm },
      archivePath: result.artifactDir,
    });
    await opts.store.setIssueItems(existing.id, [
      ...(result.issue.postIds ?? []).map((id, i) => ({ contentItemId: id, role: "post", sortOrder: i })),
      ...(result.issue.threatIds ?? []).map((id, i) => ({ contentItemId: id, role: "threat", sortOrder: i })),
    ]);
    await opts.store.appendEvent({
      issueKey: opts.issueKey,
      revision,
      eventType: result.qa.ok ? "assembled" : "qa_failed",
      payload: result.qa,
    });
    return { issueKey: opts.issueKey, revision, status: result.issue.status, qa: result.qa };
  });
}

export async function requestApproval(opts: {
  store: IssueStore;
  env: Env;
  config: AppConfig;
  issueKey: string;
}): Promise<{ issued: number; tokens?: Array<{ approverId: string; token: string; csrf: string; url: string }> }> {
  const issue = await opts.store.getIssue(opts.issueKey);
  if (!issue) throw Object.assign(new Error("issue not found"), { statusCode: 404 });
  if (issue.status !== "assembled" && issue.status !== "pending_approval") {
    throw Object.assign(new Error(`cannot request approval from ${issue.status}`), { statusCode: 409 });
  }
  await opts.store.updateIssue(opts.issueKey, { status: "pending_approval" });
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
  const raws: Array<{ approverId: string; token: string; csrf: string; url: string }> = [];
  for (const ap of opts.config.approvers.approvers) {
    const token = randomTokenHex();
    await opts.store.insertToken({
      id: uuidV4(),
      tokenSha256: sha256Hex(token),
      issueKey: opts.issueKey,
      revision: issue.revision,
      approverId: ap.id,
      expiresAt,
      consumedAt: null,
    });
    const csrf = csrfForToken(opts.env.APP_SECRET, token);
    const url = `${opts.env.PUBLIC_BASE_URL}/approve/${issueKeyToPath(opts.issueKey)}/r/${issue.revision}?t=${token}`;
    raws.push({ approverId: ap.id, token, csrf, url });
  }
  await notifyStaff(opts.env, {
    event: "approval_requested",
    issueKey: opts.issueKey,
    revision: issue.revision,
    subject: issue.subject ?? "",
    urls: raws.map((r) => ({ approverId: r.approverId, url: r.url })),
    note: "GET is inert; POST consumes",
  });
  await opts.store.appendEvent({
    issueKey: opts.issueKey,
    revision: issue.revision,
    eventType: "approval_requested",
    payload: { count: raws.length, notify: opts.env.STAFF_NOTIFY_WEBHOOK ? "webhook" : "none" },
  });
  // Echoing raw tokens is a local affordance for `npm run approve:dummy`. It
  // must never key off fixtureMode: docker-compose.prod.yml sets
  // FIXTURE_MODE=true alongside APP_ENV=staging, so the old condition handed
  // live approval tokens to anyone holding the worker bearer on a public host.
  const echoTokens = opts.env.appEnv === "development" && opts.env.allowTokenEcho;
  return { issued: raws.length, ...(echoTokens ? { tokens: raws } : {}) };
}

export async function previewApproval(opts: {
  store: IssueStore;
  rawToken: string;
}): Promise<{ tokenOk: boolean; expired: boolean; consumed: boolean; issue?: IssueRow }> {
  const hash = sha256Hex(opts.rawToken);
  const tok = await opts.store.getTokenByHash(hash);
  if (!tok) return { tokenOk: false, expired: false, consumed: false };
  const expired = Date.parse(tok.expiresAt) <= Date.now();
  const issue = await opts.store.getIssue(tok.issueKey);
  return { tokenOk: true, expired, consumed: Boolean(tok.consumedAt), issue };
}

export async function consumeApproval(opts: {
  store: IssueStore;
  env: Env;
  config: AppConfig;
  rawToken: string;
  csrf: string;
  action: ApprovalAction;
  comment: string;
  approverId: string;
}): Promise<{ ok: boolean; statusCode: number; message: string; issueStatus?: string }> {
  const expectedCsrf = csrfForToken(opts.env.APP_SECRET, opts.rawToken);
  if (expectedCsrf !== opts.csrf) {
    return { ok: false, statusCode: 403, message: "invalid csrf" };
  }
  if (!["scheduled", "immediate", "reject"].includes(opts.action)) {
    return { ok: false, statusCode: 400, message: "invalid action" };
  }
  if (opts.action === "reject" && !opts.comment.trim()) {
    return { ok: false, statusCode: 400, message: "reject requires comment" };
  }
  const hash = sha256Hex(opts.rawToken);
  const tok = await opts.store.getTokenByHash(hash);
  if (!tok) return { ok: false, statusCode: 404, message: "unknown token" };
  if (Date.parse(tok.expiresAt) <= Date.now()) return { ok: false, statusCode: 410, message: "expired" };
  if (tok.consumedAt) return { ok: false, statusCode: 409, message: "token already consumed" };
  if (opts.approverId && opts.approverId !== tok.approverId) {
    return { ok: false, statusCode: 403, message: "approver mismatch" };
  }

  return opts.store.withIssueLock(tok.issueKey, async () => {
    const issue = await opts.store.getIssue(tok.issueKey);
    if (!issue) return { ok: false, statusCode: 404, message: "issue missing" };
    if (issue.revision !== tok.revision) {
      return { ok: false, statusCode: 409, message: "revision mismatch" };
    }
    const consumed = await opts.store.consumeToken(hash, new Date());
    if (!consumed) return { ok: false, statusCode: 409, message: "token already consumed" };

    if (opts.action === "reject") {
      await opts.store.updateIssue(tok.issueKey, { status: "rejected" });
      await opts.store.appendEvent({
        issueKey: tok.issueKey,
        revision: issue.revision,
        eventType: "rejected",
        actor: tok.approverId,
        payload: { comment: opts.comment },
      });
      return { ok: true, statusCode: 200, message: "rejected; assemble a new revision", issueStatus: "rejected" };
    }

    await opts.store.addApproval({
      issueKey: tok.issueKey,
      revision: issue.revision,
      approverId: tok.approverId,
      action: opts.action,
      createdAt: new Date().toISOString(),
    });
    const sentCount = await opts.store.countProductionSent();
    const needTwo = dualControlRequired({
      appEnv: opts.env.appEnv,
      force: opts.config.approvers.requireTwoApprovers,
      firstN: Number(opts.env.DUAL_CONTROL_FIRST_N) || opts.config.approvers.dualControlFirstN,
      productionSentCount: sentCount,
    });
    const approvals = await opts.store.listApprovals(tok.issueKey, issue.revision);
    const scheduledApprovals = approvals.filter((a) => a.action === "scheduled" || a.action === "immediate");
    const distinct = new Set(scheduledApprovals.map((a) => a.approverId));
    if (needTwo && distinct.size < 2) {
      await opts.store.updateIssue(tok.issueKey, { status: "pending_approval" });
      await opts.store.appendEvent({
        issueKey: tok.issueKey,
        revision: issue.revision,
        eventType: "approval_partial",
        actor: tok.approverId,
        payload: { have: distinct.size, need: 2 },
      });
      return {
        ok: true,
        statusCode: 200,
        message: "recorded; waiting for second approver",
        issueStatus: "pending_approval",
      };
    }

    const kill = combinedKill(opts.env, await opts.store.getKill());
    if (kill.l1 || kill.l2) {
      await opts.store.updateIssue(tok.issueKey, { status: "approved" });
      await opts.store.appendEvent({
        issueKey: tok.issueKey,
        revision: issue.revision,
        eventType: "approve_blocked_kill",
        actor: tok.approverId,
        payload: { kill },
      });
      return {
        ok: false,
        statusCode: 423,
        message: "kill switch blocks schedule even if approved",
        issueStatus: "approved",
      };
    }

    await opts.store.updateIssue(tok.issueKey, { status: "queued_outbox" });
    const idem = outboxIdempotencyKey(tok.issueKey, issue.revision);
    await opts.store.putOutbox({
      id: uuidV4(),
      idempotencyKey: idem,
      issueKey: tok.issueKey,
      revision: issue.revision,
      payload: {
        action: opts.action,
        scheduleType: opts.action === "immediate" ? "immediate" : "scheduled",
      },
      status: "pending",
      attempts: 0,
      lastError: null,
    });
    await opts.store.appendEvent({
      issueKey: tok.issueKey,
      revision: issue.revision,
      eventType: "queued_outbox",
      actor: tok.approverId,
      payload: { idempotencyKey: idem },
    });
    return { ok: true, statusCode: 200, message: "queued", issueStatus: "queued_outbox" };
  });
}

export async function drainOutbox(opts: {
  store: IssueStore;
  env: Env;
  config: AppConfig;
  limit: number;
  ghl?: GhlClient;
}): Promise<{ processed: number; skipped: number; failed: number }> {
  let processed = 0;
  let skipped = 0;
  let failed = 0;
  const kill = combinedKill(opts.env, await opts.store.getKill());
  const jobs = await opts.store.listOutboxPending(opts.limit);
  const ghl =
    opts.ghl ??
    new GhlClient({
      appEnv: opts.env.appEnv,
      dryRun: opts.env.dryRun,
      kill,
      baseUrl: opts.env.GHL_BASE_URL,
      version: opts.env.GHL_API_VERSION,
      sandbox: {
        locationId: opts.env.GHL_SANDBOX_LOCATION_ID ?? "",
        userId: opts.env.GHL_SANDBOX_USER_ID ?? "",
        pit: opts.env.GHL_SANDBOX_PIT ?? "",
      },
      production: {
        locationId: opts.env.GHL_PROD_LOCATION_ID ?? "",
        userId: opts.env.GHL_PROD_USER_ID ?? "",
        pit: opts.env.GHL_PROD_PIT ?? "",
      },
    });
  const twenty = new TwentyClient({
    apiUrl: opts.env.TWENTY_API_URL ?? "",
    apiKey: opts.env.TWENTY_API_KEY ?? "",
    objectName: opts.env.TWENTY_NEWSLETTER_OBJECT ?? "newsletterIssues",
  });

  for (const job of jobs) {
    if (kill.l1 || kill.l2) {
      skipped += 1;
      await opts.store.appendEvent({
        issueKey: job.issueKey,
        revision: job.revision,
        eventType: "outbox_blocked_kill",
      });
      continue;
    }
    const issue = await opts.store.getIssue(job.issueKey);
    if (!issue || issue.status !== "queued_outbox") {
      skipped += 1;
      continue;
    }
    const slot = opts.env.appEnv === "production" && !opts.env.dryRun ? "production" : "sandbox";
    const audience = resolveDrainRecipients({
      slot,
      sandboxContactIds: opts.config.approvers.sandboxAudience.contactIds,
      productionFilter: opts.config.approvers.productionAudience.filter,
    });
    try {
      if (!audience.ok) {
        throw new Error(audience.reason);
      }
      const html = loadFrozenHtml({
        artifactsRoot: artifactsRoot(opts.env.ARTIFACT_DIR),
        issueKey: issue.issueKey,
        revision: issue.revision,
        expectedSha256: issue.htmlSha256,
      });
      ghl.assertAudienceSlot(slot);
      const created = await ghl.createCampaign(slot, {
        name: `${issue.issueKey} r${issue.revision}`,
        editorType: "html",
        timeZone: issue.audienceTz,
        userId: ghl.locationFor(slot).userId || "TODO-userId",
        editorContent: html,
      });
      const payload = job.payload as { scheduleType?: "scheduled" | "immediate" };
      const scheduled = await ghl.scheduleCampaign(slot, created.id, {
        scheduleType: payload.scheduleType === "immediate" ? "immediate" : "scheduled",
        timeZone: issue.audienceTz,
        userId: ghl.locationFor(slot).userId || "TODO-userId",
        emailMeta: {
          subject: issue.subject ?? "TODO subject",
          fromName: opts.config.brand.fromName,
          fromEmail: opts.config.brand.fromEmail,
          previewText: issue.preheader,
        },
        recipients: audience.recipients,
      });
      await opts.store.appendEvent({
        issueKey: job.issueKey,
        revision: job.revision,
        eventType: "outbox_drained",
        payload: {
          dryRun: opts.env.dryRun,
          slot,
          htmlSha256: sha256Hex(html),
          htmlBytes: html.length,
          recipients: audience.recipients,
          campaignId: scheduled.campaignId,
        },
      });
      await opts.store.updateIssue(job.issueKey, {
        status: payload.scheduleType === "immediate" ? "processing" : "scheduled",
        ghlCampaignId: scheduled.campaignId,
        ghlSourceId: scheduled.sourceId,
        ghlTraceId: scheduled.traceId ?? created.traceId,
      });
      await opts.store.updateOutbox(job.id, { status: "done", attempts: job.attempts + 1 });
      await twenty.upsertNewsletterIssue({
        issueKey: job.issueKey,
        status: "scheduled",
        campaignId: scheduled.campaignId,
        archiveUrl: issue.archivePath,
      });
      processed += 1;
    } catch (err) {
      failed += 1;
      await opts.store.updateOutbox(job.id, {
        status: "failed",
        attempts: job.attempts + 1,
        lastError: err instanceof Error ? err.message : String(err),
      });
      await opts.store.updateIssue(job.issueKey, { status: "failed" });
    }
  }
  return { processed, skipped, failed };
}

export function signArchive(env: Env, issueKey: string, revision: number, htmlSha256: string): string {
  return archiveSig(env.APP_SECRET, issueKey, revision, htmlSha256);
}
