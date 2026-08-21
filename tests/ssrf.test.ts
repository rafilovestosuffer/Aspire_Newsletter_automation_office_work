import { describe, expect, it } from "vitest";
import { SsrfError, safeFetch } from "../src/ingest/ssrf";

describe("SSRF allowlist", () => {
  it("blocks redirect to link-local metadata IP", async () => {
    const allowHosts = new Set(["todo.example.invalid"]);
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.startsWith("https://todo.example.invalid/")) {
        return new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data/" },
        });
      }
      throw new Error(`fetch should not follow to ${url}`);
    };
    await expect(
      safeFetch("https://todo.example.invalid/feed", {
        allowHosts,
        fetchImpl,
        timeoutMs: 1000,
      }),
    ).rejects.toBeInstanceOf(SsrfError);
  });

  it("allows an allowlisted 200", async () => {
    const allowHosts = new Set(["todo.example.invalid"]);
    const fetchImpl: typeof fetch = async () =>
      new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    const res = await safeFetch("https://todo.example.invalid/feed", { allowHosts, fetchImpl });
    expect(res.body.toString()).toBe("ok");
  });
});
