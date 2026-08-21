/** Per-instance mutex so parallel tests with separate MemoryStores do not share a process lock. */
export class KeyedMutex {
  private readonly chains = new Map<string, Promise<unknown>>();

  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = prev.then(() => gate);
    this.chains.set(key, next.catch(() => undefined));
    await prev.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

const processMutex = new KeyedMutex();

export async function withMemoryLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return processMutex.runExclusive(key, fn);
}

export function advisoryLockSql(): string {
  return "SELECT pg_advisory_xact_lock(hashtext($1))";
}
