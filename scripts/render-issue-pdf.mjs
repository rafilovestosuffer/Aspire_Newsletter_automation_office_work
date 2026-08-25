#!/usr/bin/env node
// Render a frozen issue artifact to a review PDF.
//
// This is a REVIEW artifact, not the thing subscribers receive. It wraps the
// frozen email HTML in the chrome an approver needs to make a decision in one
// pass: what this issue is, what the QA gate said, and what the reader will
// actually see.
//
// Two rules make it trustworthy:
//   1. It prints the frozen `email.html` from an artifact directory and
//      verifies its SHA-256 against `issue.json` first. It never re-renders,
//      so the PDF cannot drift from the bytes that were approved.
//   2. It annotates rather than edits. GHL merge tokens are shown as visible
//      annotations in the wrapper only; the frozen bytes are untouched.
//
// Usage: node scripts/render-issue-pdf.mjs <artifact-dir> <out.pdf>
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const [artifactDirArg, outPathArg] = process.argv.slice(2);
if (!artifactDirArg || !outPathArg) {
  console.error("usage: node scripts/render-issue-pdf.mjs <artifact-dir> <out.pdf>");
  process.exit(2);
}
const artifactDir = resolve(artifactDirArg);
const outPath = resolve(outPathArg);
const PORT = Number(process.env.CHROME_DEBUG_PORT ?? 9224);

// --- locate Chromium -------------------------------------------------------
// The plan-doc renderer hardcoded one path, which breaks the moment the
// browser is updated or the script runs anywhere else.
function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.PLAYWRIGHT_BROWSERS_PATH
      ? join(process.env.PLAYWRIGHT_BROWSERS_PATH, "chromium", "chrome-linux", "chrome")
      : undefined,
    "/opt/pw-browsers/chromium/chrome-linux/chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  // Fall back to a glob over versioned Playwright installs.
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
  if (existsSync(base)) {
    for (const d of readdirSafe(base)) {
      const p = join(base, d, "chrome-linux", "chrome");
      if (existsSync(p)) return p;
    }
  }
  throw new Error(
    `no Chromium found. Set CHROME_PATH to a Chromium/Chrome binary. Looked in: ${candidates.join(", ")}`,
  );
}
function readdirSafe(d) {
  try {
    return readdirSync(d);
  } catch {
    return [];
  }
}

// --- load the frozen artifact ---------------------------------------------
function readJson(name) {
  const p = join(artifactDir, name);
  if (!existsSync(p)) throw new Error(`missing ${name} in ${artifactDir}`);
  return JSON.parse(readFileSync(p, "utf8"));
}
const emailPath = join(artifactDir, "email.html");
if (!existsSync(emailPath)) throw new Error(`missing email.html in ${artifactDir}`);
const emailHtml = readFileSync(emailPath, "utf8");
const issue = readJson("issue.json");
const qa = readJson("qa-report.json");
const text = existsSync(join(artifactDir, "email.txt")) ? readFileSync(join(artifactDir, "email.txt"), "utf8") : "";

const actualSha = createHash("sha256").update(emailHtml, "utf8").digest("hex");
if (issue.htmlSha256 && actualSha !== issue.htmlSha256) {
  throw new Error(
    `frozen html sha256 mismatch: issue.json says ${issue.htmlSha256}, email.html hashes to ${actualSha}. ` +
      `Refusing to print — the artifact on disk is not the one that was frozen.`,
  );
}

// --- wrapper ---------------------------------------------------------------
const esc = (s) =>
  String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/**
 * Make GHL merge tokens visible as annotations.
 *
 * `{{unsubscribe_link}}` is correct in a real send and meaningless in a
 * document a human is asked to approve — in the previous demo it printed
 * literally and looked like a bug. Applied to a copy for display only.
 */
function annotateMergeTokens(html) {
  return html.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, name) => {
    return `<span style="background:#fdf6e8;border:1px dashed #c8912a;color:#8a6316;padding:0 4px;font-size:11px;">merge tag: ${esc(name)}</span>`;
  });
}

const byteLen = Buffer.byteLength(emailHtml, "utf8");
const WARN_BYTES = 81_920;
const CLIP_BYTES = 104_448;
const budgetState =
  byteLen >= CLIP_BYTES ? ["stop", "over the Gmail clip threshold"]
  : byteLen >= WARN_BYTES ? ["warn", "over the warn threshold, under the clip threshold"]
  : ["ok", "within budget"];

const failures = qa.failures ?? [];
const warnings = qa.warnings ?? [];
const verdict = qa.ok === false || failures.length ? ["stop", "QA FAILED"] : ["ok", "QA PASSED"];

const row = (k, v) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`;
const list = (items, empty) =>
  items.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : `<p class="faint">${esc(empty)}</p>`;

const wrapper = `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(issue.subject ?? "Issue")}</title>
<style>
  /* Shares the strategy document's palette so the two PDFs read as one family. */
  :root {
    --ink:#12181f; --ink-soft:#3d4a58; --ink-faint:#6b7885; --rule:#d7dde4;
    --accent:#1f4e9c; --accent-soft:#eef3fb;
    --warn-bg:#fdf6e8; --warn:#c8912a; --stop-bg:#fdeeee; --stop:#b03a3a;
    --ok-bg:#eef7f0; --ok:#3f7d52;
  }
  @page { size: Letter; margin: 20mm 18mm 18mm 18mm; }
  /* Noto Color Emoji is last but present: the previous demo omitted it, which
     is why an emoji in the source rendered as a missing-glyph box. */
  body { font-family:"Bitstream Charter","Liberation Serif",Georgia,serif; color:var(--ink);
         font-size:10.5pt; line-height:1.5; margin:0; }
  .doc h1, .doc h2, .doc h3, .sans { font-family:"Liberation Sans","DejaVu Sans",Arial,"Noto Color Emoji",sans-serif; }
  .doc h1 { font-size:24pt; line-height:1.2; margin:0 0 6pt; }
  .doc h2 { font-size:13pt; margin:18pt 0 6pt; padding-bottom:3pt; border-bottom:1px solid var(--rule); }
  .eyebrow { font-family:"Liberation Sans",sans-serif; font-size:8pt; letter-spacing:1.5px;
             text-transform:uppercase; color:var(--ink-faint); margin:0 0 10pt; }
  .faint { color:var(--ink-faint); }
  .page-break { page-break-before: always; }
  /* Every rule that could match a plain element is scoped to .doc.
     The embedded email is a table layout of its own; an unscoped
     a bare td border-bottom here draws a hairline under every row of it,
     and a bare table width:100% stretches its buttons edge to edge. The email must be styled only by its own inlined attributes. */
  .doc table { border-collapse:collapse; width:100%; margin:8pt 0; font-size:9.5pt; }
  .doc th, .doc td { text-align:left; vertical-align:top; padding:5pt 8pt 5pt 0;
                     border-bottom:1px solid var(--rule); }
  .doc th { font-family:"Liberation Sans",sans-serif; font-weight:normal; color:var(--ink-faint);
            width:34%; white-space:nowrap; }
  code, .mono { font-family:"Liberation Mono","DejaVu Sans Mono",monospace; font-size:8.5pt; word-break:break-all; }
  .badge { font-family:"Liberation Sans",sans-serif; font-size:8pt; font-weight:bold; letter-spacing:.5px;
           padding:2pt 6pt; border-radius:3px; text-transform:uppercase; }
  .badge.ok { background:var(--ok-bg); color:var(--ok); }
  .badge.warn { background:var(--warn-bg); color:var(--warn); }
  .badge.stop { background:var(--stop-bg); color:var(--stop); }
  .doc ul { margin:4pt 0; padding-left:16pt; }
  .doc li { margin-bottom:2pt; font-size:9.5pt; }
  /* The email itself, at its true 600px width, framed so the reader can see
     where the message ends and the paper begins. */
  .frame { border:1px solid var(--rule); background:#fff; width:600px; margin:10pt auto 0; }
  .frame table { border-collapse:separate; }
  .frame-note { text-align:center; font-size:8pt; color:var(--ink-faint); margin-top:4pt; }
  pre.plaintext { font-family:"Liberation Mono",monospace; font-size:8pt; line-height:1.45;
                  white-space:pre-wrap; word-break:break-word; background:#f7f9fb;
                  border:1px solid var(--rule); padding:8pt; }
</style></head><body>
<script>
  // The review render is offline by design — it never fetches remote brand
  // assets. An unreachable image would otherwise print as a broken-image icon
  // and read as a defect in the newsletter rather than a property of the
  // render, so label it instead.
  addEventListener("DOMContentLoaded", () => {
    for (const img of document.querySelectorAll(".frame img")) {
      const swap = () => {
        const note = document.createElement("div");
        note.textContent = "brand image not fetched in review render: " + img.getAttribute("src");
        note.setAttribute("style",
          "font:italic 10px/1.4 'Liberation Sans',sans-serif;color:#8a6316;background:#fdf6e8;" +
          "border:1px dashed #c8912a;padding:4px 6px;display:inline-block;max-width:100%;");
        img.replaceWith(note);
      };
      if (img.complete && img.naturalWidth === 0) swap();
      else img.addEventListener("error", swap);
    }
  });
</script>

<div class="doc">
<p class="eyebrow">Newsletter issue &middot; internal review copy</p>
<h1>${esc(issue.subject ?? "(no subject)")}</h1>
<p class="faint" style="margin-top:0;">${esc(issue.preheader ?? "")}</p>

<table>
  ${row("Issue key", esc(issue.issueKey))}
  ${row("ISO week / revision", `${esc(issue.isoWeek)} &middot; r${esc(issue.revision)}`)}
  ${row("Status", esc(issue.status))}
  ${row("Audience timezone", esc(issue.audienceTz))}
  ${row("Items", `${(issue.threatIds ?? []).length} threat &middot; ${(issue.briefIds ?? []).length} brief &middot; ${(issue.postIds ?? []).length} post`)}
  ${row("Frozen html sha256", `<span class="mono">${esc(actualSha)}</span>`)}
  ${row("Rendered", esc(new Date().toISOString()))}
</table>

<p class="faint" style="font-size:9pt;">
  What follows is the frozen <code>email.html</code> for this revision, printed at its true 600px
  width &mdash; not a mockup and not a re-render. This document shows the light palette only;
  dark-mode clients receive the same HTML with the <code>prefers-color-scheme</code> block in
  <code>templates/brand-shell.mjml</code> applied, which is a client render mode rather than a
  second issue. Merge tokens are annotated for review and are not part of the frozen bytes.
</p>

<h2>Pre-send checks</h2>
<table>
  ${row("QA verdict", `<span class="badge ${verdict[0]}">${esc(verdict[1])}</span>`)}
  ${row("HTML size", `<span class="badge ${budgetState[0]}">${byteLen.toLocaleString("en-US")} bytes</span> &nbsp;<span class="faint">${esc(budgetState[1])} &mdash; Gmail clips at ${CLIP_BYTES.toLocaleString("en-US")}</span>`)}
  ${row("Plaintext part", text ? `${Buffer.byteLength(text, "utf8").toLocaleString("en-US")} bytes` : `<span class="badge stop">missing</span>`)}
</table>

<h3 class="sans" style="font-size:10pt;margin-bottom:2pt;">Failures</h3>
${list(failures, "None. Nothing blocks this issue from being approved.")}

<h3 class="sans" style="font-size:10pt;margin-bottom:2pt;">Warnings</h3>
${list(warnings, "None.")}

<p class="faint" style="font-size:9pt;">
  Warnings do not block a send. Placeholder warnings on legal name and postal address are the
  exception worth reading twice: a valid physical postal address is a CAN-SPAM requirement, and
  the sending legal entity must be confirmed before this goes to a real list.
</p>

<div class="page-break"></div>
<h2>The email, as the reader sees it</h2>
</div>
<div class="frame">${annotateMergeTokens(emailHtml)}</div>
<p class="frame-note">Frozen email.html &middot; 600px &middot; light palette</p>

<div class="doc">
<div class="page-break"></div>
<h2>Appendix &mdash; text/plain part</h2>
<p class="faint" style="font-size:9pt;">Sent as the alternative part of the same message. Every reader on a text-only client sees this and nothing else.</p>
<pre class="plaintext">${esc(text || "(missing)")}</pre>
</div>

</body></html>`;

const tmp = mkdtempSync(join(tmpdir(), "issue-pdf-"));
const wrapperPath = join(tmp, "review.html");
writeFileSync(wrapperPath, wrapper);

// --- print -----------------------------------------------------------------
// CDP rather than --print-to-pdf so we can supply a footer template with real
// page numbers; Chromium ignores CSS @page margin boxes.
const CHROME = findChrome();
const chrome = spawn(
  CHROME,
  [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
    "--disable-dev-shm-usage", "--no-first-run",
    `--remote-debugging-port=${PORT}`, "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);

// Attach to a PAGE target, not the browser endpoint: Page.* is only available
// on a page-level session.
async function endpoint() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await r.json();
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error("chrome did not expose a page target");
}

const ws = new WebSocket(await endpoint());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id); pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  }
};
const send = (method, params = {}) =>
  new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });

await send("Page.enable");
const loaded = new Promise((res) => {
  const h = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === "Page.loadEventFired") { ws.removeEventListener("message", h); res(); }
  };
  ws.addEventListener("message", h);
});
await send("Page.navigate", { url: `file://${wrapperPath}` });
await loaded;
await sleep(1200); // let fonts settle before paginating

const footer = `
<div style="width:100%;font-size:7pt;font-family:'Liberation Sans',Arial,sans-serif;
            color:#8a949e;padding:0 18mm;display:flex;justify-content:space-between;">
  <span>${esc(issue.issueKey ?? "")} &middot; r${esc(issue.revision ?? "")} &middot; internal review copy</span>
  <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
</div>`;

const { data } = await send("Page.printToPDF", {
  printBackground: true,
  paperWidth: 8.5, paperHeight: 11,
  marginTop: 0.55, marginBottom: 0.71, marginLeft: 0.71, marginRight: 0.71,
  displayHeaderFooter: true,
  headerTemplate: "<div></div>",
  footerTemplate: footer,
  preferCSSPageSize: false,
});

writeFileSync(outPath, Buffer.from(data, "base64"));
console.log(`wrote ${outPath} (${verdict[1]}, ${byteLen} html bytes, sha ${actualSha.slice(0, 12)})`);
ws.close();
chrome.kill();
