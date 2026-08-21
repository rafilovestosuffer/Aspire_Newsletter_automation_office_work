import type { Env } from "../env";

/** Staff webhook only. Never a subscriber list send. */
export async function notifyStaff(env: Env, payload: Record<string, unknown>): Promise<void> {
  const url = env.STAFF_NOTIFY_WEBHOOK.trim();
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "e02-control-plane", ...payload }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    /* placeholder: do not fail assemble/approval if staff webhook is down */
  }
}
