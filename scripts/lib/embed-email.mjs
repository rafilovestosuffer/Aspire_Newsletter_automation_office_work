// Prepare a full email HTML document for embedding inside a larger page.
//
// The email is a complete document: doctype, <html>, <head><style>, <body>.
// Dropping that straight into a <div> looks like it works and does not:
//
//   * The HTML parser does not nest a second <body>. It merges that tag's
//     attributes onto the page's real <body>, so the email's
//     `background-color` repaints the whole surrounding document.
//   * Its <style> block is hoisted and applies page-wide. MJML's own resets
//     (`table,td{border-collapse:collapse}`, `body{margin:0}`) and the `.dm-*`
//     dark-mode rules then restyle the host page.
//
// So: lift the stylesheet out, scope every rule under the frame, and return
// the body's inner HTML plus the style attribute the frame should carry.

/**
 * Rewrite one CSS selector so it can only match inside `scope`.
 * `body`/`html` become the scope element itself — inside the frame, the
 * frame *is* the document body.
 */
function scopeSelector(sel, scope) {
  const s = sel.trim();
  if (!s) return "";
  if (s === "body" || s === "html" || s === ":root") return scope;
  if (s.startsWith("body ") || s.startsWith("html ")) return `${scope} ${s.slice(5)}`;
  return `${scope} ${s}`;
}

/**
 * Scope a stylesheet under a selector, descending into conditional groups
 * (`@media`, `@supports`) and leaving at-rules that have no selectors to
 * scope (`@font-face`, `@keyframes`) untouched.
 */
export function scopeCss(css, scope) {
  // Strip comments first. Without this a comma inside comment prose is read as
  // a selector separator, and the rule that follows the comment ends up with
  // no scope at all — which is how `.dm-bg` and `.pill` escaped the frame.
  // Comments carry nothing the embedded copy needs.
  css = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let out = "";
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    if (open === -1) break;
    const prelude = css.slice(i, open).trim();

    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") depth--;
      j++;
    }
    const body = css.slice(open + 1, j - 1);

    if (/^@(media|supports|layer|container)/i.test(prelude)) {
      out += `${prelude}{${scopeCss(body, scope).trim()}}\n`;
    } else if (prelude.startsWith("@")) {
      out += `${prelude}{${body}}\n`;
    } else {
      const scoped = prelude
        .split(",")
        .map((sel) => scopeSelector(sel, scope))
        .filter(Boolean)
        .join(",");
      if (scoped) out += `${scoped}{${body}}\n`;
    }
    i = j;
  }
  return out;
}

/**
 * Split an email document into the pieces needed to embed it.
 *
 * Returns `{ css, bodyStyle, content }`. A string that is already a fragment
 * (no <body>) passes through as content with no css.
 */
export function embedEmail(html, scope = ".frame") {
  const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);

  const bodyOpen = html.match(/<body([^>]*)>/i);
  const bodyStyle = bodyOpen?.[1]?.match(/style\s*=\s*"([^"]*)"/i)?.[1] ?? "";

  let content = html;
  if (bodyOpen) {
    const start = html.indexOf(bodyOpen[0]) + bodyOpen[0].length;
    const end = html.toLowerCase().lastIndexOf("</body>");
    content = html.slice(start, end === -1 ? undefined : end);
  }
  // Strip any stray document-level tags the slice may still carry. Left in
  // place they re-trigger the exact parser behaviour this function avoids.
  content = content.replace(/<\/?(?:html|head|body)[^>]*>/gi, "").replace(/<!doctype[^>]*>/gi, "");

  return { css: styles.map((s) => scopeCss(s, scope)).join("\n"), bodyStyle, content };
}
