import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "../env";
import type { AppConfig, ApprovalAction, ContentItem, IngestScope } from "../types";
import { ISSUE_SCHEMA_VERSION, TERMINAL_NOOP_STATUSES } from "../types";
import { archiveSig, csrfForToken, randomTokenHex, safeEqualHex, sha256Hex, uuidV4 } from "../domain/hash";
import { buildIssueKey, issueKeyToPath, parseIssueKey } from "../domain/issueKey";
import { dualControlRequired, envKill, mergeKill, outboxIdempotencyKey } from "../domain/policy";
import {
  DRY_RUN_CAMPAIGN_ID,
  canReconcileTransition,
  mapGhlStatus,
  outboxBackoffMs,
  outboxShouldDeadLetter,
  isPermanentSendError,
  PermanentSendError,
  RECONCILABLE_FROM,
} from "../domain/lifecycle";
import type { IssueStore } from "../store/types";
import type { IssueRow } from "../store/types";
import { assembleFromItems, loadFrozenHtml } from "../assemble/pipeline";
import { brandCompletenessProblems } from "../qa/gates";
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
    // Only the selection window. This used to read every content item ever
    // ingested and filter in memory, so cost grew without bound over time.
    const cutoff = new Date(opts.now.getTime() - opts.config.relevance.postLookbackDays * 86_400_000);
    const items = await opts.store.listContentSince(cutoff);
    const result = await assembleFromItems({
      issue: { ...existing, revision },
      items,
      config: opts.config,
      now: opts.now,
      artifactsRoot: artifactsRoot(opts.env.ARTIFACT_DIR),
      publicBaseUrl: opts.env.PUBLIC_BASE_URL,
      llmProvider: opts.env.LLM_PROVIDER,
      llmApiKey: opts.env.LLM_API_KEY ?? "",
      llmModel: opts.env.LLM_MODEL ?? "",
      requireCompleteBrand: opts.env.appEnv !== "development",
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
  if (!safeEqualHex(opts.csrf, expectedCsrf)) {
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

/** One place to build the client, so drain and reconcile cannot drift apart. */
function ghlClientFor(env: Env, kill: { l1: boolean; l2: boolean }): GhlClient {
  return new GhlClient({
    appEnv: env.appEnv,
    dryRun: env.dryRun,
    kill,
    baseUrl: env.GHL_BASE_URL,
    version: env.GHL_API_VERSION,
    sandbox: {
      locationId: env.GHL_SANDBOX_LOCATION_ID ?? "",
      userId: env.GHL_SANDBOX_USER_ID ?? "",
      pit: env.GHL_SANDBOX_PIT ?? "",
    },
    production: {
      locationId: env.GHL_PROD_LOCATION_ID ?? "",
      userId: env.GHL_PROD_USER_ID ?? "",
      pit: env.GHL_PROD_PIT ?? "",
    },
  });
}

export async function drainOutbox(opts: {
  store: IssueStore;
  env: Env;
  config: AppConfig;
  limit: number;
  ghl?: GhlClient;
}): Promise<{ processed: number; skipped: number; failed: number; retried: number }> {
  let processed = 0;
  let skipped = 0;
  let failed = 0;
  let retried = 0;
  const kill = combinedKill(opts.env, await opts.store.getKill());
  const jobs = await opts.store.listOutboxPending(opts.limit);
  const ghl = opts.ghl ?? ghlClientFor(opts.env, kill);
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
        throw new PermanentSendError(audience.reason);
      }
      // Second layer behind the QA gate. QA runs at assemble time; config can
      // be edited between assemble and drain, and this is the last point before
      // the list is addressed. Sandbox is exempt: seed sends during the spike
      // legitimately run on scaffolding.
      if (slot === "production") {
        const brandProblems = brandCompletenessProblems(opts.config.brand);
        if (brandProblems.length) {
          throw new PermanentSendError(
            `refusing production send with incomplete brand config: ${brandProblems.join("; ")}`,
          );
        }
      }
      let html: string;
      try {
        html = loadFrozenHtml({
          artifactsRoot: artifactsRoot(opts.env.ARTIFACT_DIR),
          issueKey: issue.issueKey,
          revision: issue.revision,
          expectedSha256: issue.htmlSha256,
        });
      } catch (err) {
        throw new PermanentSendError(err instanceof Error ? err.message : String(err));
      }
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
        // Provenance for the dual-control count. Recorded here because this is
        // the only place that knows which audience was actually addressed and
        // whether the call was real; reconcile later reads it rather than
        // re-deriving it from an environment that may since have changed.
        audienceSlot: slot,
        sendWasDryRun: scheduled.dryRun,
      });
      await opts.store.updateOutbox(job.id, {
        status: "done",
        attempts: job.attempts + 1,
        nextAttemptAt: null,
      });
      await twenty.upsertNewsletterIssue({
        issueKey: job.issueKey,
        status: "scheduled",
        campaignId: scheduled.campaignId,
        archiveUrl: issue.archivePath,
      });
      processed += 1;
    } catch (err) {
      // Retry with backoff before giving up. Previously the first error marked
      // both the row and the issue `failed`, so one transient GHL blip burned
      // the issue and needed an operator to rebuild it by hand.
      const attempts = job.attempts + 1;
      const message = err instanceof Error ? err.message : String(err);
      // A refusal fails the same way every time, so escalate it immediately
      // rather than spending the retry budget on it.
      const permanent = isPermanentSendError(err);
      const deadLetter = permanent || outboxShouldDeadLetter(attempts);

      if (deadLetter) {
        failed += 1;
        await opts.store.updateOutbox(job.id, {
          status: "failed",
          attempts,
          lastError: message,
          nextAttemptAt: null,
        });
        // Only now does the issue itself fail; the watchdog escalates from here.
        await opts.store.updateIssue(job.issueKey, { status: "failed" });
        await opts.store.appendEvent({
          issueKey: job.issueKey,
          revision: job.revision,
          eventType: "outbox_dead_letter",
          payload: { attempts, error: message, permanent },
        });
      } else {
        retried += 1;
        const nextAttemptAt = new Date(Date.now() + outboxBackoffMs(attempts)).toISOString();
        // Row stays `pending` and the issue stays `queued_outbox`, so the next
        // drain picks it up once the backoff elapses.
        await opts.store.updateOutbox(job.id, {
          status: "pending",
          attempts,
          lastError: message,
          nextAttemptAt,
        });
        await opts.store.appendEvent({
          issueKey: job.issueKey,
          revision: job.revision,
          eventType: "outbox_retry_scheduled",
          payload: { attempts, nextAttemptAt, error: message },
        });
      }
    }
  }
  return { processed, skipped, failed, retried };
}

export interface ReconcileResult {
  checked: number;
  transitioned: number;
  matched: number;
  /** In flight but not observable: no campaign, or a DRY_RUN placeholder. */
  unobservable: number;
  /** GHL reported a status with no local meaning (draft, archived). */
  unmapped: number;
  /** A mapped status the state machine refused to apply. */
  refused: number;
  errors: number;
}

/**
 * Bring issue status back in line with what GHL actually did.
 *
 * This is the only path that reaches `sent`, and therefore the only thing that
 * makes countProductionSent() meaningful. It strictly *observes*: the state
 * machine in domain/lifecycle.ts forbids reaching a sending state from anything
 * that has not already been approved and drained, so no GHL response can pull
 * an unapproved or rejected issue toward a send.
 */
export async function reconcileIssues(opts: {
  store: IssueStore;
  env: Env;
  config: AppConfig;
  ghl?: GhlClient;
  now?: Date;
}): Promise<ReconcileResult> {
  const now = opts.now ?? new Date();
  const kill = combinedKill(opts.env, await opts.store.getKill());
  const ghl = opts.ghl ?? ghlClientFor(opts.env, kill);
  const result: ReconcileResult = {
    checked: 0,
    transitioned: 0,
    matched: 0,
    unobservable: 0,
    unmapped: 0,
    refused: 0,
    errors: 0,
  };

  const issues = await opts.store.listIssuesByStatus([...RECONCILABLE_FROM]);
  for (const issue of issues) {
    result.checked += 1;

    // A dry-run send produced no campaign to read. Inventing a lifecycle for it
    // would fabricate `sent` rows and, before the provenance columns, would
    // have graduated dual control off nothing at all.
    if (!issue.ghlCampaignId || issue.ghlCampaignId === DRY_RUN_CAMPAIGN_ID) {
      result.unobservable += 1;
      continue;
    }

    const slot = issue.audienceSlot ?? "sandbox";
    try {
      const remote = await ghl.getCampaign(slot, issue.ghlCampaignId);
      if (remote.dryRun) {
        result.unobservable += 1;
        continue;
      }

      const target = mapGhlStatus(remote.status);
      if (!target) {
        result.unmapped += 1;
        await opts.store.appendEvent({
          issueKey: issue.issueKey,
          revision: issue.revision,
          eventType: "reconcile_unmapped",
          payload: { ghlStatus: remote.status, localStatus: issue.status },
        });
        continue;
      }
      if (target === issue.status) {
        result.matched += 1;
        continue;
      }
      if (!canReconcileTransition(issue.status, target)) {
        result.refused += 1;
        await opts.store.appendEvent({
          issueKey: issue.issueKey,
          revision: issue.revision,
          eventType: "reconcile_refused",
          payload: { from: issue.status, to: target, ghlStatus: remote.status },
        });
        continue;
      }

      await opts.store.updateIssue(issue.issueKey, {
        status: target,
        ghlStatus: remote.status,
        ...(target === "sent" ? { sentAt: now.toISOString() } : {}),
      });
      await opts.store.appendEvent({
        issueKey: issue.issueKey,
        revision: issue.revision,
        eventType: "reconcile_transition",
        payload: { from: issue.status, to: target, ghlStatus: remote.status, slot },
      });
      result.transitioned += 1;
    } catch (err) {
      result.errors += 1;
      await opts.store.appendEvent({
        issueKey: issue.issueKey,
        revision: issue.revision,
        eventType: "reconcile_error",
        payload: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
  return result;
}

export interface WatchdogResult {
  escalated: number;
  staleApprovals: number;
  deadLetters: number;
}

/**
 * Escalate what is stuck. Notification only — never a send.
 *
 * The watchdog deliberately has no write path toward a sending state: it
 * appends events and notifies staff. An automated nudge that could send would
 * defeat the mandatory human POST-approval that the whole design rests on.
 */
export async function runWatchdog(opts: {
  store: IssueStore;
  env: Env;
  config: AppConfig;
  now?: Date;
  limit?: number;
}): Promise<WatchdogResult> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 50;
  const slaMs = opts.config.schedule.approvalSlaHours * 60 * 60 * 1000;
  const result: WatchdogResult = { escalated: 0, staleApprovals: 0, deadLetters: 0 };

  const pending = await opts.store.listIssuesByStatus(["pending_approval"]);
  for (const issue of pending) {
    const waitedMs = now.getTime() - Date.parse(issue.updatedAt);
    if (waitedMs < slaMs) continue;
    result.staleApprovals += 1;
    result.escalated += 1;
    await opts.store.appendEvent({
      issueKey: issue.issueKey,
      revision: issue.revision,
      eventType: "watchdog_approval_overdue",
      payload: { waitedHours: Math.floor(waitedMs / 3_600_000), slaHours: opts.config.schedule.approvalSlaHours },
    });
    await notifyStaff(opts.env, {
      event: "approval_overdue",
      issueKey: issue.issueKey,
      revision: issue.revision,
      subject: issue.subject ?? "",
      note: "Past approval SLA. Watchdog never sends; a human must still POST.",
    });
  }

  const dead = await opts.store.listOutboxFailed(limit);
  for (const job of dead) {
    result.deadLetters += 1;
    result.escalated += 1;
    await opts.store.appendEvent({
      issueKey: job.issueKey,
      revision: job.revision,
      eventType: "watchdog_outbox_dead_letter",
      payload: { attempts: job.attempts, lastError: job.lastError },
    });
    await notifyStaff(opts.env, {
      event: "outbox_dead_letter",
      issueKey: job.issueKey,
      revision: job.revision,
      subject: "",
      note: `Outbox gave up after ${job.attempts} attempts: ${job.lastError ?? "unknown"}`,
    });
  }

  return result;
}

/**
 * Retention keeps a generous multiple of the selection window so a late
 * re-assemble or a backdated collect still has its source material.
 */
export const RETENTION_WINDOW_MULTIPLE = 4;

/**
 * Drop content older than the retention window. Items cited by any issue are
 * never removed, so frozen issues stay reproducible from their sources.
 */
export async function pruneContent(opts: {
  store: IssueStore;
  config: AppConfig;
  now: Date;
}): Promise<{ removed: number; before: string; retentionDays: number }> {
  const retentionDays = opts.config.relevance.postLookbackDays * RETENTION_WINDOW_MULTIPLE;
  const before = new Date(opts.now.getTime() - retentionDays * 86_400_000);
  const removed = await opts.store.pruneContent(before);
  return { removed, before: before.toISOString(), retentionDays };
}

export function signArchive(env: Env, issueKey: string, revision: number, htmlSha256: string): string {
  return archiveSig(env.APP_SECRET, issueKey, revision, htmlSha256);
}
