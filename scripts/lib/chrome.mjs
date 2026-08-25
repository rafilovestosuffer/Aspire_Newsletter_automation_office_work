// Locate a Chromium/Chrome binary.
//
// Shared by the asset rasterizer and the review-PDF renderer. The plan-doc
// renderer hardcoded one versioned path, which breaks the moment the browser is
// updated or the script runs on another machine.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function findChrome() {
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

  // Versioned Playwright installs, e.g. /opt/pw-browsers/chromium-1194/.
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
  if (existsSync(base)) {
    for (const d of readdirSync(base)) {
      const p = join(base, d, "chrome-linux", "chrome");
      if (existsSync(p)) return p;
    }
  }
  throw new Error(
    `no Chromium found. Set CHROME_PATH to a Chromium/Chrome binary. Looked in: ${candidates.join(", ")}`,
  );
}
