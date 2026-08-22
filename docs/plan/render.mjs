// Render plan.html to PDF via Chrome DevTools Protocol.
// CDP (rather than the --print-to-pdf flag) so we can supply a custom footer
// template with real page numbers; Chromium ignores CSS @page margin boxes.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const [htmlPath, outPath] = process.argv.slice(2);
const PORT = 9223;

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
  "--disable-dev-shm-usage", "--no-first-run",
  `--remote-debugging-port=${PORT}`, "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });

// Attach to a PAGE target, not the browser endpoint: domains like Page.* are
// only available on a page-level session.
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
await send("Page.navigate", { url: `file://${htmlPath}` });
await loaded;
await sleep(1200); // let fonts settle before paginating

const footer = `
<div style="width:100%;font-size:7pt;font-family:'Liberation Sans',Arial,sans-serif;
            color:#8a949e;padding:0 18mm;display:flex;justify-content:space-between;">
  <span>Aspire — Weekly Authority Newsletter · Strategy &amp; Plan</span>
  <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
</div>`;

const { data } = await send("Page.printToPDF", {
  printBackground: true,
  paperWidth: 8.5, paperHeight: 11,
  marginTop: 0.79, marginBottom: 0.71, marginLeft: 0.71, marginRight: 0.71,
  displayHeaderFooter: true,
  headerTemplate: "<div></div>",
  footerTemplate: footer,
  preferCSSPageSize: false,
});

writeFileSync(outPath, Buffer.from(data, "base64"));
console.log(`wrote ${outPath}`);
ws.close(); chrome.kill();
