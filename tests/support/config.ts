import { loadConfig } from "../../src/config";
import type { AppConfig } from "../../src/types";

/**
 * A config whose brand block would actually be legal to send.
 *
 * config/brand.yaml.example is deliberately full of TODO placeholders, and the
 * compliance gate rejects those outside development. Tests that exercise a
 * staging or production path therefore need real-looking brand facts — the
 * same thing a real deployment needs before it can send.
 *
 * Hosts are under .test (RFC 6761 reserved) so nothing here can resolve.
 */
export function withCompleteBrand(base: AppConfig = loadConfig()): AppConfig {
  return {
    ...base,
    brand: {
      ...base.brand,
      displayName: "Aspire",
      legalName: "Aspire Example Holdings LLC",
      postalAddress: "1 Example Plaza, Suite 200, Wilmington, DE 19801",
      fromName: "Aspire Weekly",
      fromEmail: "newsletter@mail.aspire.test",
      replyTo: "hello@mail.aspire.test",
      siteUrl: "https://aspire.test",
      logoUrl: "https://cdn.aspire.test/logo.png",
      archiveBaseUrl: "https://aspire.test/archive",
      unsubscribeUrl: "https://aspire.test/unsubscribe",
      preferenceUrl: "https://aspire.test/preferences",
      advertisementNotice: "",
      cdnHost: "cdn.aspire.test",
    },
  };
}
