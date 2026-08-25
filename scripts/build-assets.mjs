#!/usr/bin/env node
// Rasterize the brand SVGs in assets/brand/ to PNGs in assets/brand/dist/.
//
// PNG is what ships, not SVG. Linked SVG fails in Gmail's mobile apps for
// Google accounts and in Yahoo Mail entirely (caniemail.com/features/image-svg),
// which is a large share of any real list. SVG stays the source of truth in the
// repo because it is diffable and editable; PNG is the delivery format.
//
// Rendered at 2x so the image is crisp on retina displays and in print, with
// the email declaring the 1x width.
//
// Usage: node scripts/build-assets.mjs [--src <dir>] [--out <dir>]
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { findChrome } from "./lib/chrome.mjs";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const srcDir = resolve(argOf("--src", "assets/brand"));
const outDir = resolve(argOf("--out", join(srcDir, "dist")));
const SCALE = 2;

const svgs = readdirSync(srcDir).filter((f) => f.endsWith(".svg")).sort();
if (!svgs.length) {
  console.error(`no .svg files in ${srcDir}`);
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

/** Read width/height off the root <svg>, falling back to the viewBox. */
function dimensions(svg) {
  const w = svg.match(/<svg[^>]*\swidth="([\d.]+)"/)?.[1];
  const h = svg.match(/<svg[^>]*\sheight="([\d.]+)"/)?.[1];
  if (w && h) return { w: Number(w), h: Number(h) };
  const vb = svg.match(/viewBox="([\d.\-\s]+)"/)?.[1]?.trim().split(/\s+/);
  if (vb?.length === 4) return { w: Number(vb[2]), h: Number(vb[3]) };
  throw new Error("svg has neither width/height nor a viewBox");
}

const PORT = Number(process.env.CHROME_DEBUG_PORT ?? 9226);
const chrome = spawn(
  findChrome(),
  [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
    "--disable-dev-shm-usage", "--no-first-run",
    `--remote-debugging-port=${PORT}`, "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);

async function endpoint() {
  for (let i = 0; i < 60; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
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
// Capture on a transparent ground. Without this Chromium composites onto
// opaque white, which is invisible on a light email and a white box on a dark
// one — the artwork has to sit on whatever surface the theme provides.
await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });

for (const file of svgs) {
  const svg = readFileSync(join(srcDir, file), "utf8");
  const { w, h } = dimensions(svg);
  // Transparent background so a mark can sit on either theme's surface; the
  // header band paints its own fill.
  const page = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style>${svg}`;

  await send("Emulation.setDeviceMetricsOverride", {
    width: Math.ceil(w), height: Math.ceil(h), deviceScaleFactor: SCALE, mobile: false,
  });
  const loaded = new Promise((res) => {
    const handler = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === "Page.loadEventFired") { ws.removeEventListener("message", handler); res(); }
    };
    ws.addEventListener("message", handler);
  });
  await send("Page.navigate", { url: `data:text/html;charset=utf-8,${encodeURIComponent(page)}` });
  await loaded;
  await sleep(250); // let fonts settle before capturing

  const { data } = await send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: w, height: h, scale: SCALE },
  });
  const out = join(outDir, `${basename(file, ".svg")}.png`);
  const buf = Buffer.from(data, "base64");
  writeFileSync(out, buf);
  console.log(`${file} -> ${basename(out)} (${w}x${h} @${SCALE}x, ${buf.length} bytes)`);
}

ws.close();
chrome.kill();
