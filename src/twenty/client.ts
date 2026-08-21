/**
 * Twenty CRM projection stub.
 * Twenty APIs are schema-per-tenant (https://docs.twenty.com/developers/extend/api).
 * Missing creds → no-op. Never stores tokens, locks, or subscriber lists.
 */
export class TwentyClient {
  constructor(
    private readonly opts: {
      apiUrl: string;
      apiKey: string;
      objectName: string;
    },
  ) {}

  enabled(): boolean {
    return Boolean(this.opts.apiUrl && this.opts.apiKey);
  }

  async upsertNewsletterIssue(payload: {
    issueKey: string;
    status: string;
    campaignId?: string | null;
    archiveUrl?: string | null;
    kpis?: Record<string, number>;
  }): Promise<{ ok: true; noOp: boolean }> {
    if (!this.enabled()) {
      return { ok: true, noOp: true };
    }
    // Live REST path is workspace-specific (`POST /rest/{objectName}`). Not called without a spike.
    void payload;
    return { ok: true, noOp: true };
  }
}
