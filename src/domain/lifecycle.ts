import type { IssueStatus } from "../types";

/**
 * GHL campaign statuses.
 *
 * VERIFIED-DOCS (docs/BINDING-DECISIONS.md): taken from the Create Email
 * Campaign v3 response schema, not from a guessed payload. The spike may add
 * to this list; it must not silently reinterpret one of these.
 */
export const GHL_CAMPAIGN_STATUSES = [
  "draft",
  "scheduled",
  "processing",
  "sent",
  "failed",
  "cancelled",
  "paused",
  "archived",
] as const;

export type GhlCampaignStatus = (typeof GHL_CAMPAIGN_STATUSES)[number];

/**
 * The campaign id the client returns when nothing was actually sent.
 * Reconcile must never treat one of these as a real campaign to observe.
 */
export const DRY_RUN_CAMPAIGN_ID = "dry-run-campaign";

/**
 * Map a GHL campaign status onto ours, or undefined when it has no local
 * meaning.
 *
 * `draft` and `archived` are deliberately unmapped. A draft campaign is one we
 * created but have not scheduled, which is not a state our issue can be in
 * while in flight; `archived` is GHL-side housekeeping after the fact. Mapping
 * either would invent a transition rather than observe one, so both are
 * reported as mismatches instead.
 */
export function mapGhlStatus(status: string): IssueStatus | undefined {
  switch (status) {
    case "scheduled":
      return "scheduled";
    case "processing":
      return "processing";
    case "sent":
      return "sent";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "paused":
      return "paused";
    default:
      return undefined;
  }
}

/** Issue states reconcile is allowed to look at: a send is genuinely open. */
export const RECONCILABLE_FROM: ReadonlySet<IssueStatus> = new Set<IssueStatus>([
  "scheduled",
  "processing",
  "paused",
]);

/** States reconcile may write, all of them observations of GHL's own state. */
const RECONCILE_TARGETS: ReadonlySet<IssueStatus> = new Set<IssueStatus>([
  "scheduled",
  "processing",
  "sent",
  "failed",
  "cancelled",
  "paused",
]);

/**
 * Whether reconcile may move an issue from `from` to `to`.
 *
 * Reconcile *observes*; it must never be a second path to sending. Everything
 * before the outbox — collecting, assembled, pending_approval, approved,
 * rejected, queued_outbox — is unreachable here, so no GHL response can pull an
 * unapproved issue into a sending state or resurrect a rejected one. `sent` is
 * terminal: once recipients have it, no later API reading can undo that.
 */
export function canReconcileTransition(from: IssueStatus, to: IssueStatus): boolean {
  if (from === to) return false;
  if (!RECONCILABLE_FROM.has(from)) return false;
  if (!RECONCILE_TARGETS.has(to)) return false;
  return true;
}

/**
 * Exponential backoff for outbox retries, in milliseconds.
 *
 * Deterministic (no jitter) because a single control plane drains this queue
 * serially — there is no thundering herd to spread out, and a predictable delay
 * is far easier to reason about during an incident.
 */
export const OUTBOX_BASE_BACKOFF_MS = 60_000;
export const OUTBOX_MAX_BACKOFF_MS = 60 * 60_000;

/** Attempts before a row dead-letters. Deliberately small: a stuck send should
 * surface to a human quickly rather than retry quietly for hours. */
export const OUTBOX_MAX_ATTEMPTS = 4;

export function outboxBackoffMs(attempts: number): number {
  if (attempts < 1) return OUTBOX_BASE_BACKOFF_MS;
  const raw = OUTBOX_BASE_BACKOFF_MS * 2 ** (attempts - 1);
  return Math.min(raw, OUTBOX_MAX_BACKOFF_MS);
}

/** True once a failed attempt has exhausted the retry budget. */
export function outboxShouldDeadLetter(attempts: number): boolean {
  return attempts >= OUTBOX_MAX_ATTEMPTS;
}

/**
 * A send failure that will recur identically on retry.
 *
 * Empty recipients, a placeholder brand config and a missing frozen artifact
 * are all things only a human can fix. Retrying them burns the budget and, more
 * importantly, delays the watchdog escalation that actually gets someone
 * looking — so they dead-letter on the first attempt. Same reasoning as
 * `isRetryable` in src/llm/summarize.ts: retry transport, never retry a
 * refusal.
 */
export class PermanentSendError extends Error {
  override name = "PermanentSendError";
}

export function isPermanentSendError(err: unknown): boolean {
  if (err instanceof PermanentSendError) return true;
  // Matched by name rather than by class: src/ghl/client.ts imports this module
  // for DRY_RUN_CAMPAIGN_ID, so importing GhlBanError back would be a cycle.
  return err instanceof Error && err.name === "GhlBanError";
}
