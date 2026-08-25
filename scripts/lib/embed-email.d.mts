/** Scope a stylesheet under a selector so none of its rules can match outside it. */
export function scopeCss(css: string, scope: string): string;

/** Split an email document into the pieces needed to embed it in another page. */
export function embedEmail(
  html: string,
  scope?: string,
): { css: string; bodyStyle: string; content: string };
