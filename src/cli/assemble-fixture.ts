import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, artifactsRoot } from "../config";
import { loadEnv } from "../env";
import { assembleFromItems } from "../assemble/pipeline";
import { loadFixtureItems } from "../services/control";
import { buildIssueKey, parseIssueKey } from "../domain/issueKey";
import { ISSUE_SCHEMA_VERSION } from "../types";

const now = new Date("2026-08-20T19:00:00.000Z");

async function main() {
  const env = loadEnv();
  const config = loadConfig();
  const issueKey = buildIssueKey(config.brand.slug, config.schedule.audienceTimeZone, now);
  const parsed = parseIssueKey(issueKey);
  const items = loadFixtureItems(config);
  const result = await assembleFromItems({
    issue: {
      schemaVersion: ISSUE_SCHEMA_VERSION,
      issueKey,
      brandSlug: parsed.brandSlug,
      audienceTz: parsed.audienceTz,
      isoWeek: parsed.isoWeek,
      revision: 1,
      status: "collecting",
    },
    items,
    config,
    now,
    artifactsRoot: artifactsRoot(env.ARTIFACT_DIR),
    publicBaseUrl: env.PUBLIC_BASE_URL,
    llmProvider: "fixture",
    llmApiKey: "",
  });
  const summary = {
    issueKey: result.issue.issueKey,
    status: result.issue.status,
    htmlSha256: result.issue.htmlSha256,
    textSha256: result.issue.textSha256,
    qa: result.qa,
    artifactDir: result.artifactDir,
    sent: false,
    dryRun: true,
  };
  writeFileSync(join(result.artifactDir, "assemble-summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (!result.qa.ok && result.issue.status !== "skipped") {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
