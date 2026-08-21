import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appRoot } from "../paths";

/**
 * `docs/BINDING-DECISIONS.md` is the go-live gate, and this makes it one in
 * code rather than only on a checklist.
 *
 * Gate B requires zero UNVERIFIED rows before a production send. Leaving that
 * as a line in the runbook means one distracted afternoon can skip it, so the
 * production audience is refused while any row is still unverified — no
 * environment variable overrides it.
 *
 * Fails **closed**: a missing or unreadable log counts as unverified. The
 * failure mode of guessing wrong here is sending a real newsletter against an
 * API whose schema nobody has confirmed.
 */

const UNVERIFIED_MARKER = "UNVERIFIED";

export interface BindingLogState {
  green: boolean;
  unverifiedCount: number;
  reason: string;
}

export function bindingLogPath(): string {
  return join(appRoot(), "docs", "BINDING-DECISIONS.md");
}

export function readBindingLog(path: string = bindingLogPath()): BindingLogState {
  if (!existsSync(path)) {
    return {
      green: false,
      unverifiedCount: -1,
      reason: `binding log not found at ${path}; failing closed`,
    };
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return {
      green: false,
      unverifiedCount: -1,
      reason: `binding log unreadable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Count only table rows, so the prose explaining what UNVERIFIED means does
  // not keep the gate shut forever.
  const rows = text
    .split("\n")
    .filter((line) => line.trimStart().startsWith("|") && line.includes(UNVERIFIED_MARKER));

  if (rows.length === 0) {
    return { green: true, unverifiedCount: 0, reason: "binding log has no UNVERIFIED rows" };
  }
  return {
    green: false,
    unverifiedCount: rows.length,
    reason: `${rows.length} UNVERIFIED row(s) in the binding log; run the sandbox spike and record the evidence`,
  };
}
