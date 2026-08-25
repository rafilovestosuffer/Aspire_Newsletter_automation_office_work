export type AppEnv = "development" | "staging" | "production";

/** Matches contracts/content-item.v1.schema.json and config YAML schemaVersion. */
export const CONTENT_SCHEMA_VERSION = "1.0.0";
export const ISSUE_SCHEMA_VERSION = "1.0.0";

export type IssueStatus =
  | "collecting"
  | "assembled"
  | "qa_failed"
  | "pending_approval"
  | "rejected"
  | "approved"
  | "queued_outbox"
  | "scheduled"
  | "processing"
  | "sent"
  | "failed"
  | "cancelled"
  | "paused"
  | "skipped";

export const TERMINAL_NOOP_STATUSES: ReadonlySet<IssueStatus> = new Set([
  "scheduled",
  "processing",
  "sent",
]);

export type ContentKind = "post" | "threat" | "brief";

/** Which slice of the feed registry an ingest run covers. */
export type IngestScope = "posts" | "threats" | "briefs" | "all";

export type Severity = "critical" | "high" | "medium" | "low" | "unknown";

export interface ContentItem {
  schemaVersion: typeof CONTENT_SCHEMA_VERSION;
  id: string;
  kind: ContentKind;
  sourceId: string;
  canonicalUrl: string;
  title: string;
  excerpt: string;
  publishedAt: string;
  cveIds: string[];
  rawHash: string;
  score?: number;
  severity?: Severity;
  vendorProduct?: string;
  knownRansomware?: boolean;
  /** CISA KEV remediation deadline (ISO date). The reader's actual SLA. */
  dueDate?: string;
  /** CISA KEV required action, verbatim from the catalogue. */
  requiredAction?: string;
}

export interface NewsletterIssue {
  schemaVersion: typeof ISSUE_SCHEMA_VERSION;
  issueKey: string;
  brandSlug: string;
  audienceTz: string;
  isoWeek: string;
  revision: number;
  status: IssueStatus;
  subject?: string;
  preheader?: string;
  htmlSha256?: string;
  textSha256?: string;
  postIds?: string[];
  threatIds?: string[];
  briefIds?: string[];
  ghlCampaignId?: string | null;
  ghlSourceId?: string | null;
  ghlTraceId?: string | null;
  archivePath?: string | null;
  /** Which audience the send addressed. Set at drain, read by the sent count. */
  audienceSlot?: AudienceSlot | null;
  /** Whether that send was a dry run. Only a false here counts as a real send. */
  sendWasDryRun?: boolean | null;
  sentAt?: string | null;
  /** Last status observed on the GHL campaign by reconcile. */
  ghlStatus?: string | null;
}

export type AudienceSlot = "sandbox" | "production";

export type ApprovalAction = "scheduled" | "immediate" | "reject";

export interface LlmPostOut {
  id: string;
  summary: string;
  ctaLabel: string;
}

/** A third-party industry/AI item — never one of Aspire's own articles. */
export interface LlmBriefOut {
  id: string;
  summary: string;
}

export interface LlmThreatOut {
  id: string;
  whyItMatters: string;
  severity: Exclude<Severity, "unknown">;
}

export interface LlmOutput {
  subject: string;
  preheader: string;
  editorBlurb: string;
  posts: LlmPostOut[];
  threats: LlmThreatOut[];
  briefs: LlmBriefOut[];
}

export interface QaReport {
  ok: boolean;
  failures: string[];
  warnings: string[];
}

export interface BrandConfig {
  schemaVersion: string;
  slug: string;
  displayName: string;
  legalName: string;
  postalAddress: string;
  fromName: string;
  fromEmail: string;
  replyTo: string;
  primaryColor: string;
  backgroundColor: string;
  textColor: string;
  logoUrl: string;
  siteUrl: string;
  archiveBaseUrl: string;
  unsubscribeUrl: string;
  preferenceUrl: string;
  ghlUnsubscribeMergeTag: string;
  advertisementNotice: string;
  cdnHost: string;
  /** Optional native promo block. Absent or blank heading means no block renders. */
  promo?: { heading: string; body: string; ctaLabel: string; ctaUrl: string };
  /**
   * Optional design tokens. Every field is optional and falls back to the
   * defaults in `src/render/theme.ts`, so a brand.yaml written before these
   * existed keeps rendering exactly as it did.
   */
  mutedColor?: string;
  borderColor?: string;
  cardBackgroundColor?: string;
  /** Fill colour per KEV severity label, used for the severity pill. */
  severityColors?: { critical?: string; high?: string; medium?: string; low?: string };
  /**
   * Fill colour per remediation-deadline bucket. `overdue` is past the CISA
   * date, `soon` is within `urgencySoonDays`, `ok` is everything else.
   */
  urgencyColors?: { overdue?: string; soon?: string; ok?: string };
  /**
   * Brand-hosted images only. Third-party art is deliberately unsupported:
   * hotlinking would leak reader IPs and bypass the host allow-list, and
   * `src/ingest/sanitize.ts` strips markup from feed text before it is seen.
   */
  heroImageUrl?: string;
  sectionIcons?: { threats?: string; briefs?: string; posts?: string };
}

export interface FeedConfig {
  schemaVersion: string;
  cms: { originHost: string; rssUrl: string };
  threatFeeds: Array<{
    id: string;
    kind: "kev-json" | "rss";
    url: string;
    allowHost: string;
  }>;
  /** Third-party industry/AI news. Rendered as attributed, never as Aspire's own writing. */
  industryFeeds?: Array<{
    id: string;
    url: string;
    allowHost: string;
    sourceName: string;
  }>;
}

export interface RelevanceConfig {
  schemaVersion: string;
  postLookbackDays: number;
  postCap: number;
  threatCap: number;
  briefCap: number;
  allowThreatOnly: boolean;
  allowPostsOnly: boolean;
  keywords: string[];
  shortenerHosts: string[];
  gmailClipBytes: number;
  gmailWarnBytes: number;
  subjectMaxChars: number;
}

export interface ScheduleConfig {
  schemaVersion: string;
  audienceTimeZone: string;
  opsTimeZone: string;
  sendWeekday: number;
  sendHour: number;
  assembleLeadHours: number;
  approvalSlaHours: number;
  skipWeeks: string[];
  holidayCalendar: string[];
}

export interface ApproverConfig {
  schemaVersion: string;
  requireTwoApprovers: boolean;
  dualControlFirstN: number;
  approvers: Array<{ id: string; email: string; name: string }>;
  delegates: Array<{ from: string; to: string }>;
  sandboxAudience: { kind: "contactIds"; contactIds: string[] };
  productionAudience: { kind: "filter"; filter: Record<string, unknown>; note: string };
}

export interface AppConfig {
  brand: BrandConfig;
  feeds: FeedConfig;
  relevance: RelevanceConfig;
  schedule: ScheduleConfig;
  approvers: ApproverConfig;
}
