import type { BrandConfig } from "../types";

/**
 * Resolved design tokens for one issue.
 *
 * Every value has a default, so a `brand.yaml` written before these fields
 * existed renders with the same palette the redesign shipped with. The
 * defaults match `docs/plan/newsletter-strategy-and-plan.html`, which is what
 * makes the email and the review PDF read as one document family.
 */
export interface Theme {
  primary: string;
  /** Serif, for headlines, numerals and the opening blurb. */
  displayFont: string;
  /** Sans, for kickers, pills, meta and anything UI-shaped. */
  bodyFont: string;
  ornament: string;
  background: string;
  text: string;
  muted: string;
  border: string;
  card: string;
  severity: Record<string, string>;
  severityFallback: string;
  urgency: { overdue: string; soon: string; ok: string };
}

const DEFAULTS = {
  // Web-safe both. A newsletter cannot depend on a webfont: Outlook on Windows
  // will not load one, and the fallback is what most of the list would see.
  // Georgia against Arial gives the editorial contrast without that risk.
  // Single-quoted inside: these land in MJML attributes, which are themselves
  // double-quoted, and a double quote here terminates the attribute early.
  displayFont: "Georgia, 'Liberation Serif', 'Times New Roman', serif",
  bodyFont: "Arial, 'Liberation Sans', Helvetica, sans-serif",
  muted: "#6B7885",
  border: "#D7DDE4",
  card: "#F7F9FB",
  severity: { critical: "#B03A3A", high: "#C8912A", medium: "#3D4A58", low: "#6B7885" },
  urgency: { overdue: "#B03A3A", soon: "#C8912A", ok: "#6B7885" },
} as const;

/** A KEV deadline this close is styled as urgent rather than merely dated. */
export const URGENCY_SOON_DAYS = 3;

export function resolveTheme(brand: BrandConfig): Theme {
  const sev = brand.severityColors ?? {};
  const urg = brand.urgencyColors ?? {};
  return {
    primary: brand.primaryColor,
    displayFont: brand.displayFont ?? DEFAULTS.displayFont,
    bodyFont: brand.bodyFont ?? DEFAULTS.bodyFont,
    ornament: brand.ornamentColor ?? brand.primaryColor,
    background: brand.backgroundColor,
    text: brand.textColor,
    muted: brand.mutedColor ?? DEFAULTS.muted,
    border: brand.borderColor ?? DEFAULTS.border,
    card: brand.cardBackgroundColor ?? DEFAULTS.card,
    severity: {
      critical: sev.critical ?? DEFAULTS.severity.critical,
      high: sev.high ?? DEFAULTS.severity.high,
      medium: sev.medium ?? DEFAULTS.severity.medium,
      low: sev.low ?? DEFAULTS.severity.low,
    },
    // An unrecognised severity string must still render a pill rather than an
    // empty background; the LLM supplies this field and is not enum-pinned.
    severityFallback: DEFAULTS.severity.medium,
    urgency: {
      overdue: urg.overdue ?? DEFAULTS.urgency.overdue,
      soon: urg.soon ?? DEFAULTS.urgency.soon,
      ok: urg.ok ?? DEFAULTS.urgency.ok,
    },
  };
}

export function severityColor(theme: Theme, severity: string): string {
  return theme.severity[severity.trim().toLowerCase()] ?? theme.severityFallback;
}

export type UrgencyBucket = "overdue" | "soon" | "ok";

/**
 * Bucket a CISA remediation deadline relative to `now`. Returns undefined when
 * there is no parseable due date, so the caller renders no deadline pill at
 * all rather than a misleading neutral one.
 */
export function urgencyBucket(dueDate: string | undefined, now: number): UrgencyBucket | undefined {
  if (!dueDate) return undefined;
  const parsed = Date.parse(`${dueDate}T00:00:00.000Z`);
  if (Number.isNaN(parsed)) return undefined;
  const days = Math.ceil((parsed - now) / 86_400_000);
  if (days < 0) return "overdue";
  if (days <= URGENCY_SOON_DAYS) return "soon";
  return "ok";
}
