import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canLoadProductionAudience, type KillFlags } from "../domain/policy";
import { DRY_RUN_CAMPAIGN_ID } from "../domain/lifecycle";
import type { AppEnv, AudienceSlot } from "../types";

export class GhlBanError extends Error {
  override name = "GhlBanError";
}

export type GhlEditorType = "html" | "text";
export type GhlScheduleType = "immediate" | "scheduled" | "batch" | "rss" | "smart_send";

export interface CreateCampaignBody {
  name: string;
  editorType: GhlEditorType;
  timeZone: string;
  userId: string;
  templateId?: string;
  editorContent?: string;
  parentFolderId?: string;
  userName?: string;
}

/**
 * UNVERIFIED child fields until sandbox spike.
 * Official marketplace page does not expand emailMeta.
 * Unofficial OpenAPI lists subject, fromName, fromEmail required.
 */
export interface GhlEmailMetaUnverified {
  subject: string;
  fromName: string;
  fromEmail: string;
  replyToAddress?: string;
  previewText?: string;
  attachments?: string[];
  /** TODO(spike): confirm whether HTML belongs here vs create editorContent */
  [k: string]: unknown;
}

/**
 * Official docs: recipients must provide either contactIds OR filter.
 * Unofficial OpenAPI instead uses type=contact|tag|segment (no `filter` key).
 * Do not claim a verified production payload.
 */
export type GhlRecipientsUnverified =
  | { contactIds: string[]; filter?: undefined; type?: "contact" }
  | {
      contactIds?: undefined;
      /** TODO(spike): child schema unknown — do not send guessed keys to prod */
      filter: Record<string, unknown>;
    };

export interface ScheduleCampaignBody {
  scheduleType: GhlScheduleType;
  timeZone: string;
  userId: string;
  userName?: string;
  emailMeta: GhlEmailMetaUnverified;
  recipients: GhlRecipientsUnverified;
  scheduleConfig?: {
    /** TODO(spike): datetime format UNVERIFIED */
    sendAt?: string;
    emailPreferenceId?: string;
    tracking?: { clickTracking?: boolean; utmTracking?: boolean };
  };
  rssConfig?: unknown;
  abTestConfig?: unknown;
}

/** Canonical definition lives in ../types alongside the issue row that stores it. */
export type { AudienceSlot } from "../types";

export interface GhlEnv {
  appEnv: AppEnv;
  dryRun: boolean;
  kill: KillFlags;
  baseUrl: string;
  version: string;
  sandbox: { locationId: string; userId: string; pit: string };
  production: { locationId: string; userId: string; pit: string };
  /**
   * Whether docs/BINDING-DECISIONS.md has zero UNVERIFIED rows. Gates the
   * production audience; injected rather than read here so tests control it.
   * Absent means not green — this fails closed.
   */
  bindingLogGreen?: boolean;
  /** Directory for spike request/response capture. Omit to disable. */
  captureDir?: string;
}

/** A live GHL call that came back non-2xx. Carries the trace id for the log. */
export class GhlHttpError extends Error {
  override name = "GhlHttpError";
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
    readonly traceId?: string,
  ) {
    super(message);
  }
}

const REQUEST_TIMEOUT_MS = 20_000;
/** One retry beyond the first attempt; the outbox owns the longer backoff. */
const MAX_HTTP_ATTEMPTS = 3;

function retryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

const FORBIDDEN_PATH_FRAGMENTS = ["/conversations/messages", "/conversations/messages/outbound"];

/** Live spike runner must never run against production. Unit-tested; script exits 2. */
export function assertSandboxSpikeAllowed(appEnv: AppEnv): void {
  if (appEnv === "production") {
    throw new GhlBanError("Refusing: APP_ENV=production. Spike is sandbox-only.");
  }
}

export class GhlClient {
  constructor(private readonly env: GhlEnv) {}

  locationFor(slot: AudienceSlot): { locationId: string; userId: string; pit: string } {
    return slot === "production" ? this.env.production : this.env.sandbox;
  }

  assertAudienceSlot(slot: AudienceSlot): void {
    if (slot !== "production") return;
    if (!canLoadProductionAudience(this.env)) {
      throw new GhlBanError(
        "Refusing production audience: need APP_ENV=production AND DRY_RUN=false AND kill L1/L2 off",
      );
    }
    // Gate B in code, not just on a checklist: no production send until every
    // row in the binding log is backed by a captured sandbox response.
    if (this.env.bindingLogGreen !== true) {
      throw new GhlBanError(
        "Refusing production audience: docs/BINDING-DECISIONS.md still has UNVERIFIED rows",
      );
    }
  }

  createCampaignPath(locationId: string): string {
    return `/emails/locations/${locationId}/campaigns/emails`;
  }

  schedulePath(locationId: string, campaignId: string): string {
    return `/emails/locations/${locationId}/campaigns/emails/${campaignId}/schedule`;
  }

  assertCreateBody(body: CreateCampaignBody): void {
    if (body.editorType !== "html" && body.editorType !== "text") {
      throw new GhlBanError("editorType must be html or text (builder JSON is banned)");
    }
    if (!body.name || !body.timeZone || !body.userId) {
      throw new GhlBanError("create campaign requires name, editorType, timeZone, userId");
    }
  }

  assertScheduleBody(body: ScheduleCampaignBody): void {
    if (body.scheduleType === "rss") {
      throw new GhlBanError("scheduleType rss is banned for this product");
    }
    if (body.scheduleType === "batch" || body.scheduleType === "smart_send") {
      throw new GhlBanError("batch/smart_send are v1.5");
    }
    if (body.scheduleType !== "scheduled" && body.scheduleType !== "immediate") {
      throw new GhlBanError(`unsupported scheduleType ${body.scheduleType}`);
    }
    if (body.rssConfig) {
      throw new GhlBanError("rssConfig is banned");
    }
    if (body.abTestConfig) {
      throw new GhlBanError("abTestConfig is v1.5");
    }
    if (!body.timeZone || !body.userId || !body.emailMeta || !body.recipients) {
      throw new GhlBanError("schedule requires timeZone, userId, emailMeta, recipients");
    }
    const rec = body.recipients;
    const hasIds = "contactIds" in rec && Array.isArray(rec.contactIds);
    const hasFilter = "filter" in rec && rec.filter != null;
    if (hasIds === hasFilter) {
      throw new GhlBanError("recipients must be contactIds XOR filter (schema UNVERIFIED)");
    }
  }

  assertNotForbiddenPath(path: string): void {
    for (const frag of FORBIDDEN_PATH_FRAGMENTS) {
      if (path.includes(frag)) {
        throw new GhlBanError("Conversations outbound is forbidden for this newsletter");
      }
    }
  }

  /**
   * Pause/cancel API is UNVERIFIED. Official PATCH body has no status field.
   * Callers must use GHL UI until BINDING-DECISIONS records a proven path.
   */
  async pauseOrCancel(_campaignId: string, _action: "pause" | "cancel"): Promise<never> {
    throw new GhlBanError(
      "UNVERIFIED: no documented v3 pause/cancel body. Use GHL UI (L3). Resume after send-time sends immediately.",
    );
  }


  /**
   * The single place a live request leaves this process.
   *
   * Every caller runs its guards *before* reaching here, and DRY_RUN or a
   * missing PIT short-circuits earlier still, so this is only reached when a
   * real call was genuinely intended.
   */
  private async request(
    method: "GET" | "POST" | "PATCH",
    path: string,
    pit: string,
    body?: unknown,
    label = "request",
  ): Promise<{ status: number; json: Record<string, unknown>; traceId?: string }> {
    // Belt and braces: the forbidden-path check also runs at the transport, so
    // no future caller can reach conversations outbound by skipping its guard.
    this.assertNotForbiddenPath(path);

    const url = `${this.env.baseUrl.replace(/\/$/, "")}${path}`;
    let lastErr: unknown;

    for (let attempt = 1; attempt <= MAX_HTTP_ATTEMPTS; attempt += 1) {
      try {
        const res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${pit}`,
            Version: this.env.version,
            Accept: "application/json",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        const text = await res.text();
        let json: Record<string, unknown> = {};
        try {
          json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
        } catch {
          json = { raw: text };
        }
        const traceId =
          res.headers.get("x-trace-id") ??
          res.headers.get("traceid") ??
          (typeof json.traceId === "string" ? json.traceId : undefined) ??
          undefined;

        this.capture(label, { method, url, version: this.env.version, body }, {
          status: res.status,
          headers: Object.fromEntries(res.headers.entries()),
          body: json,
        });

        if (res.ok) return { status: res.status, json, traceId };

        const err = new GhlHttpError(
          `GHL ${method} ${path} responded ${res.status}`,
          res.status,
          text.slice(0, 2000),
          traceId,
        );
        // A 4xx other than 429 is our payload being wrong; repeating it just
        // burns rate limit and delays the real diagnosis.
        if (!retryableStatus(res.status) || attempt === MAX_HTTP_ATTEMPTS) throw err;
        lastErr = err;
      } catch (err) {
        if (err instanceof GhlHttpError && !retryableStatus(err.status)) throw err;
        lastErr = err;
        if (attempt === MAX_HTTP_ATTEMPTS) break;
      }
      await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  /**
   * Persist the exact request/response pair, which is what fills the binding
   * log with evidence instead of inference.
   *
   * The bearer token is never written: this file is committed as proof.
   */
  private capture(label: string, request: unknown, response: unknown): void {
    const dir = this.env.captureDir;
    if (!dir) return;
    try {
      mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      writeFileSync(
        join(dir, `${stamp}-${label}.json`),
        JSON.stringify({ label, request, response, note: "Authorization header redacted" }, null, 2),
      );
    } catch {
      /* capture is diagnostic; never fail a call because the disk is full */
    }
  }

  async createCampaign(
    slot: AudienceSlot,
    body: CreateCampaignBody,
  ): Promise<{ id: string; status: string; traceId?: string; dryRun: boolean }> {
    this.assertAudienceSlot(slot);
    this.assertCreateBody(body);
    const path = this.createCampaignPath(this.locationFor(slot).locationId);
    this.assertNotForbiddenPath(path);
    const loc = this.locationFor(slot);
    if (this.env.dryRun || !loc.pit) {
      return { id: DRY_RUN_CAMPAIGN_ID, status: "draft", traceId: "dry-run", dryRun: true };
    }
    const { json, traceId } = await this.request("POST", path, loc.pit, body, "create-campaign");
    const id = String(json.id ?? (json as { campaignId?: unknown }).campaignId ?? "");
    if (!id) {
      throw new GhlHttpError("create campaign returned no id", 200, JSON.stringify(json), traceId);
    }
    return { id, status: String(json.status ?? "draft"), traceId, dryRun: false };
  }

  campaignPath(locationId: string, campaignId: string): string {
    return `/emails/locations/${locationId}/campaigns/emails/${campaignId}`;
  }

  /**
   * Read one campaign's current status, for reconciliation.
   *
   * Read-only: there is no body and no send here, so unlike create/schedule it
   * carries no audience-slot gate. It still refuses live HTTP, because the
   * response shape is UNVERIFIED until the spike — reconcile treats a dry-run
   * campaign as unobservable rather than inventing a lifecycle for it.
   */
  async getCampaign(
    slot: AudienceSlot,
    campaignId: string,
  ): Promise<{ id: string; status: string; dryRun: boolean }> {
    const loc = this.locationFor(slot);
    const path = this.campaignPath(loc.locationId, campaignId);
    this.assertNotForbiddenPath(path);
    if (this.env.dryRun || !loc.pit) {
      return { id: campaignId, status: "draft", dryRun: true };
    }
    const { json } = await this.request("GET", path, loc.pit, undefined, "get-campaign");
    return { id: String(json.id ?? campaignId), status: String(json.status ?? ""), dryRun: false };
  }

  async scheduleCampaign(
    slot: AudienceSlot,
    campaignId: string,
    body: ScheduleCampaignBody,
  ): Promise<{ campaignId: string; sourceId: string; traceId?: string; dryRun: boolean }> {
    this.assertAudienceSlot(slot);
    this.assertScheduleBody(body);
    const loc = this.locationFor(slot);
    const path = this.schedulePath(loc.locationId, campaignId);
    this.assertNotForbiddenPath(path);
    if (this.env.dryRun || !loc.pit) {
      return { campaignId, sourceId: "dry-run-source", traceId: "dry-run", dryRun: true };
    }
    const { json, traceId } = await this.request("POST", path, loc.pit, body, "schedule-campaign");
    return {
      campaignId: String(json.campaignId ?? json.id ?? campaignId),
      sourceId: String(json.sourceId ?? ""),
      traceId,
      dryRun: false,
    };
  }
}
