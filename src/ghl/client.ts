import { canLoadProductionAudience, type KillFlags } from "../domain/policy";
import type { AppEnv } from "../types";

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

export type AudienceSlot = "sandbox" | "production";

export interface GhlEnv {
  appEnv: AppEnv;
  dryRun: boolean;
  kill: KillFlags;
  baseUrl: string;
  version: string;
  sandbox: { locationId: string; userId: string; pit: string };
  production: { locationId: string; userId: string; pit: string };
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
    if (slot === "production" && !canLoadProductionAudience(this.env)) {
      throw new GhlBanError(
        "Refusing production audience: need APP_ENV=production AND DRY_RUN=false AND kill L1/L2 off",
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

  async createCampaign(
    slot: AudienceSlot,
    body: CreateCampaignBody,
  ): Promise<{ id: string; status: string; traceId?: string; dryRun: boolean }> {
    this.assertAudienceSlot(slot);
    this.assertCreateBody(body);
    const path = this.createCampaignPath(this.locationFor(slot).locationId);
    this.assertNotForbiddenPath(path);
    if (this.env.dryRun || !this.locationFor(slot).pit) {
      return { id: "dry-run-campaign", status: "draft", traceId: "dry-run", dryRun: true };
    }
    throw new GhlBanError("Live GHL HTTP is not enabled in this build without an explicit future spike runner");
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
    throw new GhlBanError("Live GHL HTTP is not enabled in this build without an explicit future spike runner");
  }
}
