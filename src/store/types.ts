import type { ContentItem, IssueStatus, NewsletterIssue } from "../types";
import type { KillFlags } from "../domain/policy";

export interface IssueRow extends NewsletterIssue {
  id: string;
  freezeJson?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalTokenRow {
  id: string;
  tokenSha256: string;
  issueKey: string;
  revision: number;
  approverId: string;
  expiresAt: string;
  consumedAt: string | null;
}

export interface OutboxRow {
  id: string;
  idempotencyKey: string;
  issueKey: string;
  revision: number;
  payload: unknown;
  status: "pending" | "processing" | "done" | "failed";
  attempts: number;
  lastError: string | null;
  /** Earliest time a retry may run. Null means eligible now. */
  nextAttemptAt?: string | null;
}

export interface ApprovalRecord {
  issueKey: string;
  revision: number;
  approverId: string;
  action: string;
  createdAt: string;
}

export interface IssueStore {
  ping(): Promise<boolean>;
  withIssueLock<T>(issueKey: string, fn: () => Promise<T>): Promise<T>;
  getIssue(issueKey: string): Promise<IssueRow | undefined>;
  insertIssue(row: IssueRow): Promise<void>;
  updateIssue(issueKey: string, patch: Partial<IssueRow>): Promise<void>;
  /**
   * Issues genuinely sent to the production audience for real.
   *
   * Feeds dual-control graduation, so it must exclude sandbox and DRY_RUN
   * sends: counting those would drop the second-approver requirement without a
   * single real production issue having gone out.
   */
  countProductionSent(): Promise<number>;
  listIssuesByStatus(statuses: IssueStatus[]): Promise<IssueRow[]>;
  upsertContent(item: ContentItem): Promise<void>;
  /** Every content item. Admin/diagnostic use — unbounded, not for assemble. */
  listContent(): Promise<ContentItem[]>;
  /** Items published at or after `cutoff`. The selection window for assemble. */
  listContentSince(cutoff: Date): Promise<ContentItem[]>;
  /**
   * Delete content published before `before` that no issue references.
   * Returns rows removed.
   */
  pruneContent(before: Date): Promise<number>;
  setIssueItems(issueId: string, items: Array<{ contentItemId: string; role: string; sortOrder: number }>): Promise<void>;
  appendEvent(event: {
    issueKey: string;
    revision?: number;
    eventType: string;
    actor?: string;
    payload?: unknown;
  }): Promise<void>;
  insertToken(row: ApprovalTokenRow): Promise<void>;
  getTokenByHash(sha256: string): Promise<ApprovalTokenRow | undefined>;
  consumeToken(sha256: string, at: Date): Promise<boolean>;
  listApprovals(issueKey: string, revision: number): Promise<ApprovalRecord[]>;
  addApproval(row: ApprovalRecord): Promise<void>;
  getKill(): Promise<KillFlags>;
  setKill(level: "L1" | "L2", enabled: boolean, reason: string): Promise<void>;
  putOutbox(row: OutboxRow): Promise<"inserted" | "exists">;
  /** Pending rows whose backoff has elapsed, oldest first. */
  listOutboxPending(limit: number, now?: Date): Promise<OutboxRow[]>;
  /** Dead-lettered rows, for the watchdog to escalate. */
  listOutboxFailed(limit: number): Promise<OutboxRow[]>;
  updateOutbox(id: string, patch: Partial<OutboxRow>): Promise<void>;
  listInFlight(): Promise<IssueRow[]>;
}

export function statusOf(s: string): IssueStatus {
  return s as IssueStatus;
}
