import sanitizeHtml from "sanitize-html";

export function toSafeText(input: string): string {
  const stripped = sanitizeHtml(input, {
    allowedTags: [],
    allowedAttributes: {},
    disallowedTagsMode: "discard",
  });
  return stripped.replace(/\s+/g, " ").trim();
}

export function looksLikeScript(input: string): boolean {
  return /<\s*script/i.test(input) || /javascript:/i.test(input) || /onerror\s*=/i.test(input);
}

export function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
