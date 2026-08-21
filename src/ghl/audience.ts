/**
 * Audience for GHL schedule. Production filter child schema stays UNVERIFIED.
 * Empty sandbox contactIds and empty prod filter are refused — they are not a send.
 */
import type { GhlRecipientsUnverified } from "./client";

export type DrainAudienceOk = { ok: true; recipients: GhlRecipientsUnverified; slot: "sandbox" | "production" };
export type DrainAudienceErr = { ok: false; reason: string; slot: "sandbox" | "production" };

export function productionFilterUnverified(filter: Record<string, unknown>): boolean {
  return Object.keys(filter).length === 0;
}

export function resolveDrainRecipients(opts: {
  slot: "sandbox" | "production";
  sandboxContactIds: string[];
  productionFilter: Record<string, unknown>;
}): DrainAudienceOk | DrainAudienceErr {
  if (opts.slot === "sandbox") {
    const ids = opts.sandboxContactIds.filter((id) => id.trim().length > 0);
    if (!ids.length) {
      return { ok: false, slot: "sandbox", reason: "sandbox contactIds is empty; refuse GHL schedule" };
    }
    return { ok: true, slot: "sandbox", recipients: { contactIds: ids } };
  }
  if (productionFilterUnverified(opts.productionFilter)) {
    return {
      ok: false,
      slot: "production",
      reason: "productionAudience.filter is empty/UNVERIFIED; refuse GHL schedule",
    };
  }
  return { ok: true, slot: "production", recipients: { filter: opts.productionFilter } };
}
