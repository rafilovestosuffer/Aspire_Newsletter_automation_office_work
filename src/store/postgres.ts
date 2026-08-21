import pg from "pg";
import { AsyncLocalStorage } from "node:async_hooks";
import { advisoryLockSql } from "../domain/lock";
import type { KillFlags } from "../domain/policy";
import { uuidV4 } from "../domain/hash";
import type { ContentItem } from "../types";
import type { ApprovalRecord, ApprovalTokenRow, IssueRow, IssueStore, OutboxRow } from "./types";
import { CONTENT_SCHEMA_VERSION, ISSUE_SCHEMA_VERSION } from "../types";

const lockClient = new AsyncLocalStorage<pg.PoolClient>();

function rowToIssue(r: Record<string, unknown>): IssueRow {
  const freeze = r.freeze_json as { postIds?: string[]; threatIds?: string[] } | null;
  return {
    schemaVersion: ISSUE_SCHEMA_VERSION,
    id: String(r.id),
    issueKey: String(r.issue_key),
    brandSlug: String(r.brand_slug),
    audienceTz: String(r.audience_tz),
    isoWeek: String(r.iso_week),
    revision: Number(r.revision),
    status: r.status as IssueRow["status"],
    subject: r.subject ? String(r.subject) : undefined,
    preheader: r.preheader ? String(r.preheader) : undefined,
    htmlSha256: r.html_sha256 ? String(r.html_sha256) : undefined,
    textSha256: r.text_sha256 ? String(r.text_sha256) : undefined,
    postIds: freeze?.postIds,
    threatIds: freeze?.threatIds,
    ghlCampaignId: r.ghl_campaign_id ? String(r.ghl_campaign_id) : null,
    ghlSourceId: r.ghl_source_id ? String(r.ghl_source_id) : null,
    ghlTraceId: r.ghl_trace_id ? String(r.ghl_trace_id) : null,
    archivePath: r.archive_path ? String(r.archive_path) : null,
    freezeJson: r.freeze_json,
    createdAt: (r.created_at as Date).toISOString(),
    updatedAt: (r.updated_at as Date).toISOString(),
  };
}

export class PostgresStore implements IssueStore {
  constructor(private readonly pool: pg.Pool) {}

  /** Prefer the lock-holding client so advisory xact locks actually cover writes. */
  private q(): pg.Pool | pg.PoolClient {
    return lockClient.getStore() ?? this.pool;
  }

  async ping(): Promise<boolean> {
    const { rows } = await this.q().query("SELECT 1 AS ok");
    return rows.length > 0;
  }

  async withIssueLock<T>(issueKey: string, fn: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    return lockClient.run(client, async () => {
      try {
        await client.query("BEGIN");
        await client.query(advisoryLockSql(), [issueKey]);
        const result = await fn();
        await client.query("COMMIT");
        return result;
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          /* ignore rollback failure */
        }
        throw err;
      } finally {
        client.release();
      }
    });
  }

  async getIssue(issueKey: string): Promise<IssueRow | undefined> {
    const { rows } = await this.q().query("SELECT * FROM issues WHERE issue_key = $1", [issueKey]);
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? rowToIssue(row) : undefined;
  }

  async insertIssue(row: IssueRow): Promise<void> {
    await this.q().query(
      `INSERT INTO issues (
        id, issue_key, brand_slug, audience_tz, iso_week, revision, status,
        subject, preheader, html_sha256, text_sha256, freeze_json,
        ghl_campaign_id, ghl_source_id, ghl_trace_id, archive_path
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        row.id,
        row.issueKey,
        row.brandSlug,
        row.audienceTz,
        row.isoWeek,
        row.revision,
        row.status,
        row.subject ?? null,
        row.preheader ?? null,
        row.htmlSha256 ?? null,
        row.textSha256 ?? null,
        row.freezeJson ?? null,
        row.ghlCampaignId ?? null,
        row.ghlSourceId ?? null,
        row.ghlTraceId ?? null,
        row.archivePath ?? null,
      ],
    );
  }

  async updateIssue(issueKey: string, patch: Partial<IssueRow>): Promise<void> {
    const cur = await this.getIssue(issueKey);
    if (!cur) throw new Error(`unknown issue ${issueKey}`);
    const next = { ...cur, ...patch };
    await this.q().query(
      `UPDATE issues SET
        revision=$2, status=$3, subject=$4, preheader=$5, html_sha256=$6, text_sha256=$7,
        freeze_json=$8, ghl_campaign_id=$9, ghl_source_id=$10, ghl_trace_id=$11, archive_path=$12,
        updated_at=now()
      WHERE issue_key=$1`,
      [
        issueKey,
        next.revision,
        next.status,
        next.subject ?? null,
        next.preheader ?? null,
        next.htmlSha256 ?? null,
        next.textSha256 ?? null,
        next.freezeJson ?? null,
        next.ghlCampaignId ?? null,
        next.ghlSourceId ?? null,
        next.ghlTraceId ?? null,
        next.archivePath ?? null,
      ],
    );
  }

  async countProductionSent(): Promise<number> {
    const { rows } = await this.q().query(`SELECT count(*)::int AS n FROM issues WHERE status = 'sent'`);
    return Number((rows[0] as { n: number }).n);
  }

  async upsertContent(item: ContentItem): Promise<void> {
    await this.q().query(
      `INSERT INTO content_items (
        id, schema_version, kind, source_id, canonical_url, title, excerpt, published_at, cve_ids, raw_hash, score, extra
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (id) DO UPDATE SET
        title=EXCLUDED.title, excerpt=EXCLUDED.excerpt, score=EXCLUDED.score, extra=EXCLUDED.extra`,
      [
        item.id,
        item.schemaVersion ?? CONTENT_SCHEMA_VERSION,
        item.kind,
        item.sourceId,
        item.canonicalUrl,
        item.title,
        item.excerpt,
        item.publishedAt,
        item.cveIds,
        item.rawHash,
        item.score ?? null,
        JSON.stringify({
          severity: item.severity,
          vendorProduct: item.vendorProduct,
          knownRansomware: item.knownRansomware,
        }),
      ],
    );
  }

  async listContent(): Promise<ContentItem[]> {
    const { rows } = await this.q().query("SELECT * FROM content_items");
    return rows.map((r) => {
      const extra = (r.extra ?? {}) as ContentItem;
      return {
        schemaVersion: CONTENT_SCHEMA_VERSION,
        id: String(r.id),
        kind: r.kind,
        sourceId: r.source_id,
        canonicalUrl: r.canonical_url,
        title: r.title,
        excerpt: r.excerpt,
        publishedAt: new Date(r.published_at as string).toISOString(),
        cveIds: r.cve_ids ?? [],
        rawHash: r.raw_hash,
        score: r.score ?? undefined,
        severity: extra.severity,
        vendorProduct: extra.vendorProduct,
        knownRansomware: extra.knownRansomware,
      };
    });
  }

  async setIssueItems(
    issueId: string,
    items: Array<{ contentItemId: string; role: string; sortOrder: number }>,
  ): Promise<void> {
    await this.q().query("DELETE FROM issue_items WHERE issue_id = $1", [issueId]);
    for (const it of items) {
      await this.q().query(
        "INSERT INTO issue_items (issue_id, content_item_id, role, sort_order) VALUES ($1,$2,$3,$4)",
        [issueId, it.contentItemId, it.role, it.sortOrder],
      );
    }
  }

  async appendEvent(event: {
    issueKey: string;
    revision?: number;
    eventType: string;
    actor?: string;
    payload?: unknown;
  }): Promise<void> {
    await this.q().query(
      `INSERT INTO issue_events (issue_key, revision, event_type, actor, payload) VALUES ($1,$2,$3,$4,$5)`,
      [event.issueKey, event.revision ?? null, event.eventType, event.actor ?? null, JSON.stringify(event.payload ?? {})],
    );
  }

  async insertToken(row: ApprovalTokenRow): Promise<void> {
    await this.q().query(
      `INSERT INTO approval_tokens (id, token_sha256, issue_key, revision, approver_id, expires_at, consumed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [row.id, row.tokenSha256, row.issueKey, row.revision, row.approverId, row.expiresAt, row.consumedAt],
    );
  }

  async getTokenByHash(sha256: string): Promise<ApprovalTokenRow | undefined> {
    const { rows } = await this.q().query("SELECT * FROM approval_tokens WHERE token_sha256 = $1", [sha256]);
    const r = rows[0] as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      id: String(r.id),
      tokenSha256: String(r.token_sha256),
      issueKey: String(r.issue_key),
      revision: Number(r.revision),
      approverId: String(r.approver_id),
      expiresAt: new Date(r.expires_at as string).toISOString(),
      consumedAt: r.consumed_at ? new Date(r.consumed_at as string).toISOString() : null,
    };
  }

  async consumeToken(sha256: string, at: Date): Promise<boolean> {
    const { rowCount } = await this.q().query(
      `UPDATE approval_tokens SET consumed_at = $2
       WHERE token_sha256 = $1 AND consumed_at IS NULL AND expires_at > $2`,
      [sha256, at.toISOString()],
    );
    return (rowCount ?? 0) > 0;
  }

  async listApprovals(issueKey: string, revision: number): Promise<ApprovalRecord[]> {
    const { rows } = await this.q().query(
      `SELECT payload, created_at FROM issue_events
       WHERE issue_key=$1 AND revision=$2 AND event_type='approval_posted'
       ORDER BY id`,
      [issueKey, revision],
    );
    return rows.map((r) => {
      const p = r.payload as { approverId?: string; action?: string };
      return {
        issueKey,
        revision,
        approverId: p.approverId ?? "",
        action: p.action ?? "",
        createdAt: new Date(r.created_at as string).toISOString(),
      };
    });
  }

  async addApproval(row: ApprovalRecord): Promise<void> {
    await this.appendEvent({
      issueKey: row.issueKey,
      revision: row.revision,
      eventType: "approval_posted",
      actor: row.approverId,
      payload: { approverId: row.approverId, action: row.action },
    });
  }

  async getKill(): Promise<KillFlags> {
    const { rows } = await this.q().query("SELECT key, enabled FROM kill_state");
    const flags: KillFlags = { l1: false, l2: false };
    for (const r of rows) {
      if (r.key === "L1") flags.l1 = Boolean(r.enabled);
      if (r.key === "L2") flags.l2 = Boolean(r.enabled);
    }
    return flags;
  }

  async setKill(level: "L1" | "L2", enabled: boolean, reason: string): Promise<void> {
    await this.q().query(
      `INSERT INTO kill_state (key, enabled, reason, updated_at) VALUES ($1,$2,$3,now())
       ON CONFLICT (key) DO UPDATE SET enabled=EXCLUDED.enabled, reason=EXCLUDED.reason, updated_at=now()`,
      [level, enabled, reason],
    );
  }

  async putOutbox(row: OutboxRow): Promise<"inserted" | "exists"> {
    try {
      await this.q().query(
        `INSERT INTO outbox (id, idempotency_key, issue_key, revision, payload, status, attempts, last_error)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          row.id || uuidV4(),
          row.idempotencyKey,
          row.issueKey,
          row.revision,
          JSON.stringify(row.payload),
          row.status,
          row.attempts,
          row.lastError,
        ],
      );
      return "inserted";
    } catch (err) {
      const e = err as { code?: string };
      if (e.code === "23505") return "exists";
      throw err;
    }
  }

  async listOutboxPending(limit: number): Promise<OutboxRow[]> {
    const { rows } = await this.q().query(
      `SELECT * FROM outbox WHERE status='pending' ORDER BY created_at ASC LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({
      id: String(r.id),
      idempotencyKey: String(r.idempotency_key),
      issueKey: String(r.issue_key),
      revision: Number(r.revision),
      payload: r.payload,
      status: r.status,
      attempts: Number(r.attempts),
      lastError: r.last_error,
    }));
  }

  async updateOutbox(id: string, patch: Partial<OutboxRow>): Promise<void> {
    const cur = (await this.q().query("SELECT * FROM outbox WHERE id=$1", [id])).rows[0] as
      | Record<string, unknown>
      | undefined;
    if (!cur) return;
    await this.q().query(
      `UPDATE outbox SET status=$2, attempts=$3, last_error=$4, processed_at=$5 WHERE id=$1`,
      [
        id,
        patch.status ?? cur.status,
        patch.attempts ?? cur.attempts,
        patch.lastError === undefined ? cur.last_error : patch.lastError,
        patch.status === "done" || patch.status === "failed" ? new Date().toISOString() : cur.processed_at,
      ],
    );
  }

  async listInFlight(): Promise<IssueRow[]> {
    const { rows } = await this.q().query(`SELECT * FROM issues WHERE status IN ('scheduled','processing')`);
    return rows.map((r) => rowToIssue(r as Record<string, unknown>));
  }
}
