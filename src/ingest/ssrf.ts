import { lookup } from "node:dns/promises";

export class SsrfError extends Error {
  override name = "SsrfError";
}

export interface SafeFetchOptions {
  allowHosts: Set<string>;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  fetchImpl?: typeof fetch;
  /** Skip DNS rebinding checks (tests with mocked fetch). */
  skipDnsLookup?: boolean;
}

const PRIVATE_V4 = [
  /^127\./,
  /^10\./,
  /^0\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^100\.(6[4-9]|[7-9]\d|1[0-2]\d)\./,
  /^198\.18\./,
  /^198\.19\./,
];

function isPrivateIp(address: string): boolean {
  const a = address.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (a === "::1" || a === "0:0:0:0:0:0:0:1") return true;
  if (a.startsWith("fe80:") || a.startsWith("fc") || a.startsWith("fd")) return true;
  if (a.startsWith("::ffff:")) return isPrivateIp(a.slice(7));
  return PRIVATE_V4.some((re) => re.test(a));
}

function isIpLiteral(host: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  if (host.includes(":")) return true;
  return false;
}

function hostAllowed(host: string, allowHosts: Set<string>): boolean {
  const h = host.toLowerCase();
  if (allowHosts.has(h)) return true;
  for (const a of allowHosts) {
    if (a.startsWith("*.") && h.endsWith(a.slice(1))) return true;
  }
  return false;
}

export async function assertUrlAllowed(
  raw: string | URL,
  allowHosts: Set<string>,
  skipDnsLookup = false,
): Promise<URL> {
  const u = raw instanceof URL ? raw : new URL(raw);
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new SsrfError(`blocked scheme ${u.protocol}`);
  }
  if (u.username || u.password) {
    throw new SsrfError("blocked userinfo in URL");
  }
  const host = u.hostname.toLowerCase();
  if (isIpLiteral(host) && isPrivateIp(host)) {
    throw new SsrfError(`blocked private IP ${host}`);
  }
  if (!hostAllowed(host, allowHosts)) {
    throw new SsrfError(`host not allowlisted: ${host}`);
  }
  if (!skipDnsLookup && !isIpLiteral(host)) {
    try {
      const records = await Promise.race([
        lookup(host, { all: true, verbatim: true }),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("dns-timeout")), 400);
        }),
      ]);
      for (const rec of records) {
        if (isPrivateIp(rec.address)) {
          throw new SsrfError(`DNS resolved to private IP ${rec.address}`);
        }
      }
    } catch (err) {
      if (err instanceof SsrfError) throw err;
    }
  }
  return u;
}

export async function safeFetch(
  url: string,
  opts: SafeFetchOptions,
): Promise<{ finalUrl: string; body: Buffer; status: number; contentType: string }> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const maxBytes = opts.maxBytes ?? 1_000_000;
  const maxRedirects = opts.maxRedirects ?? 3;
  const fetchImpl = opts.fetchImpl ?? fetch;
  let current = new URL(url);

  const skipDns = Boolean(opts.skipDnsLookup || opts.fetchImpl);
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    await assertUrlAllowed(current, opts.allowHosts, skipDns);
    const res = await fetchImpl(current.href, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "e02-newsletter-control-plane/1.0", accept: "*/*" },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new SsrfError("redirect without Location");
      current = new URL(loc, current);
      continue;
    }
    if (!res.ok) {
      throw new SsrfError(`upstream HTTP ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new SsrfError("response exceeds maxBytes");
    return {
      finalUrl: current.href,
      body: buf,
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
    };
  }
  throw new SsrfError("too many redirects");
}
