import type { AppEnv } from "../types";

export interface KillFlags {
  l1: boolean;
  l2: boolean;
}

export function envKill(killSwitch: string, killOutbox: string): KillFlags {
  const on = (v: string) => v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
  return { l1: on(killSwitch), l2: on(killOutbox) };
}

export function mergeKill(envFlags: KillFlags, db: KillFlags): KillFlags {
  return { l1: envFlags.l1 || db.l1, l2: envFlags.l2 || db.l2 };
}

export function dualControlRequired(opts: {
  appEnv: AppEnv;
  force: boolean;
  firstN: number;
  productionSentCount: number;
}): boolean {
  if (opts.force) return true;
  if (opts.appEnv !== "production") return false;
  return opts.productionSentCount < opts.firstN;
}

export function outboxIdempotencyKey(issueKey: string, revision: number): string {
  return `${issueKey}:${revision}:schedule`;
}

export function canLoadProductionAudience(opts: {
  appEnv: AppEnv;
  dryRun: boolean;
  kill: KillFlags;
}): boolean {
  return opts.appEnv === "production" && opts.dryRun === false && !opts.kill.l1 && !opts.kill.l2;
}
