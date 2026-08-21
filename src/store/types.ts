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
  countProductionSent(): Promise<number>;
  upsertContent(item: ContentItem): Promise<void>;
  listContent(): Promise<ContentItem[]>;
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
  listOutboxPending(limit: number): Promise<OutboxRow[]>;
  updateOutbox(id: string, patch: Partial<OutboxRow>): Promise<void>;
  listInFlight(): Promise<IssueRow[]>;
}

export function statusOf(s: string): IssueStatus {
  return s as IssueStatus;
}
