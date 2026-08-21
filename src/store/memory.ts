import { KeyedMutex } from "../domain/lock";
import type { KillFlags } from "../domain/policy";
import type { ContentItem } from "../types";
import type { ApprovalRecord, ApprovalTokenRow, IssueRow, IssueStore, OutboxRow } from "./types";

export class MemoryStore implements IssueStore {
  private readonly mutex = new KeyedMutex();
  issues = new Map<string, IssueRow>();
  content = new Map<string, ContentItem>();
  issueItems = new Map<string, Array<{ contentItemId: string; role: string; sortOrder: number }>>();
  events: Array<{
    issueKey: string;
    revision?: number;
    eventType: string;
    actor?: string;
    payload?: unknown;
    createdAt: string;
  }> = [];
  tokens = new Map<string, ApprovalTokenRow>();
  approvals: ApprovalRecord[] = [];
  kill: KillFlags = { l1: false, l2: false };
  outbox = new Map<string, OutboxRow>();

  async ping(): Promise<boolean> {
    return true;
  }

  async withIssueLock<T>(issueKey: string, fn: () => Promise<T>): Promise<T> {
    return this.mutex.runExclusive(issueKey, fn);
  }

  async getIssue(issueKey: string): Promise<IssueRow | undefined> {
    const row = this.issues.get(issueKey);
    return row ? { ...row } : undefined;
  }

  async insertIssue(row: IssueRow): Promise<void> {
    this.issues.set(row.issueKey, { ...row });
  }

  async updateIssue(issueKey: string, patch: Partial<IssueRow>): Promise<void> {
    const cur = this.issues.get(issueKey);
    if (!cur) throw new Error(`unknown issue ${issueKey}`);
    this.issues.set(issueKey, { ...cur, ...patch, updatedAt: new Date().toISOString() });
  }

  async countProductionSent(): Promise<number> {
    let n = 0;
    for (const i of this.issues.values()) {
      if (i.status === "sent") n += 1;
    }
    return n;
  }

  async upsertContent(item: ContentItem): Promise<void> {
    this.content.set(item.id, item);
  }

  async listContent(): Promise<ContentItem[]> {
    return [...this.content.values()];
  }

  async listContentSince(cutoff: Date): Promise<ContentItem[]> {
    const floor = cutoff.getTime();
    return [...this.content.values()].filter((i) => Date.parse(i.publishedAt) >= floor);
  }

  async pruneContent(before: Date): Promise<number> {
    const floor = before.getTime();
    const referenced = new Set<string>();
    for (const items of this.issueItems.values()) {
      for (const it of items) referenced.add(it.contentItemId);
    }
    let removed = 0;
    for (const [id, item] of this.content) {
      if (referenced.has(id)) continue;
      if (Date.parse(item.publishedAt) >= floor) continue;
      this.content.delete(id);
      removed += 1;
    }
    return removed;
  }

  async setIssueItems(
    issueId: string,
    items: Array<{ contentItemId: string; role: string; sortOrder: number }>,
  ): Promise<void> {
    this.issueItems.set(issueId, items);
  }

  async appendEvent(event: {
    issueKey: string;
    revision?: number;
    eventType: string;
    actor?: string;
    payload?: unknown;
  }): Promise<void> {
    this.events.push({ ...event, createdAt: new Date().toISOString() });
  }

  async insertToken(row: ApprovalTokenRow): Promise<void> {
    this.tokens.set(row.tokenSha256, { ...row });
  }

  async getTokenByHash(sha256: string): Promise<ApprovalTokenRow | undefined> {
    const row = this.tokens.get(sha256);
    return row ? { ...row } : undefined;
  }

  async consumeToken(sha256: string, at: Date): Promise<boolean> {
    const t = this.tokens.get(sha256);
    if (!t || t.consumedAt) return false;
    t.consumedAt = at.toISOString();
    this.tokens.set(sha256, t);
    return true;
  }

  async listApprovals(issueKey: string, revision: number): Promise<ApprovalRecord[]> {
    return this.approvals.filter((a) => a.issueKey === issueKey && a.revision === revision);
  }

  async addApproval(row: ApprovalRecord): Promise<void> {
    this.approvals.push(row);
  }

  async getKill(): Promise<KillFlags> {
    return { ...this.kill };
  }

  async setKill(level: "L1" | "L2", enabled: boolean, reason: string): Promise<void> {
    if (level === "L1") this.kill.l1 = enabled;
    else this.kill.l2 = enabled;
    await this.appendEvent({ issueKey: "_system", eventType: "kill", payload: { level, enabled, reason } });
  }

  async putOutbox(row: OutboxRow): Promise<"inserted" | "exists"> {
    if (this.outbox.has(row.idempotencyKey)) return "exists";
    this.outbox.set(row.idempotencyKey, { ...row });
    return "inserted";
  }

  async listOutboxPending(limit: number): Promise<OutboxRow[]> {
    return [...this.outbox.values()].filter((o) => o.status === "pending").slice(0, limit);
  }

  async updateOutbox(id: string, patch: Partial<OutboxRow>): Promise<void> {
    for (const [k, v] of this.outbox) {
      if (v.id === id) {
        this.outbox.set(k, { ...v, ...patch });
        return;
      }
    }
  }

  async listInFlight(): Promise<IssueRow[]> {
    return [...this.issues.values()].filter((i) => i.status === "scheduled" || i.status === "processing");
  }
}
