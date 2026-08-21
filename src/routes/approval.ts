import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Env } from "../env";
import type { AppConfig, ApprovalAction } from "../types";
import type { IssueStore } from "../store/types";
import { issueKeyFromPath, issueKeyToPath } from "../domain/issueKey";
import { csrfForToken, sha256Hex } from "../domain/hash";
import { consumeApproval, previewApproval, signArchive } from "../services/control";
import { artifactsRoot } from "../config";
import { artifactDirFor } from "../assemble/pipeline";
import { escapeHtml } from "../render/compile";

export function workerAuthorized(req: FastifyRequest, env: Env): boolean {
  return req.headers.authorization === `Bearer ${env.WORKER_TOKEN}`;
}

function htmlWrap(title: string, inner: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${inner}</body></html>`;
}

export async function registerApproval(
  app: FastifyInstance,
  ctx: { env: Env; store: IssueStore; config: AppConfig },
) {
  app.get<{ Params: { issueKeyPath: string; revision: string }; Querystring: { t?: string } }>(
    "/approve/:issueKeyPath/r/:revision",
    { exposeHeadRoute: false },
    async (req, reply) => {
      const issueKey = issueKeyFromPath(req.params.issueKeyPath);
      const revision = Number(req.params.revision);
      const t = req.query.t ?? "";
      const preview = t
        ? await previewApproval({ store: ctx.store, rawToken: t })
        : { tokenOk: false, expired: false, consumed: false, issue: undefined };
      reply.header("cache-control", "no-store");
      if (!preview.tokenOk) {
        return reply.status(404).send(htmlWrap("Unknown token", "<p>No matching approval token.</p>"));
      }
      if (preview.expired) {
        return reply.status(410).send(htmlWrap("Expired", "<p>This token expired (48h TTL).</p>"));
      }
      const tok = await ctx.store.getTokenByHash(sha256Hex(t));
      const csrf = csrfForToken(ctx.env.APP_SECRET, t);
      const note = preview.consumed
        ? "<p><strong>Token already consumed.</strong> GET still does not send.</p>"
        : "<p><strong>GET and HEAD do nothing.</strong> Email scanners cannot send. Submit a button to POST.</p>";
      let previewFrame = "";
      if (preview.issue?.htmlSha256) {
        const sig = signArchive(ctx.env, issueKey, revision, preview.issue.htmlSha256);
        const src = `/archive/${issueKeyToPath(issueKey)}/r/${revision}?sig=${sig}`;
        previewFrame = `<iframe title="Frozen HTML preview" sandbox="" src="${escapeHtml(src)}" style="width:100%;min-height:480px;border:1px solid #ccc"></iframe>`;
      }
      const body = `
      ${note}
      <p>Issue <code>${escapeHtml(issueKey)}</code> revision ${revision} status ${escapeHtml(preview.issue?.status ?? "?")}</p>
      <p>Subject: ${escapeHtml(preview.issue?.subject ?? "")}</p>
      <p>Preheader: ${escapeHtml(preview.issue?.preheader ?? "")}</p>
      <p>DRY_RUN=${String(ctx.env.dryRun)} APP_ENV=${escapeHtml(ctx.env.appEnv)}</p>
      ${previewFrame}
      <form method="post" action="/approve/${issueKeyToPath(issueKey)}/r/${revision}">
        <input type="hidden" name="t" value="${escapeHtml(t)}" />
        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}" />
        <input type="hidden" name="approverId" value="${escapeHtml(tok?.approverId ?? "")}" />
        <p><button name="action" value="scheduled">Schedule</button>
           <button name="action" value="immediate">Send now</button></p>
        <p><label>Reject comment <input name="comment" /></label>
           <button name="action" value="reject">Reject</button></p>
      </form>`;
      return reply.type("text/html").send(htmlWrap("Confirm newsletter send", body));
    },
  );

  // Explicit HEAD: Fastify would otherwise auto-add HEAD from GET and collide.
  app.head<{ Params: { issueKeyPath: string; revision: string }; Querystring: { t?: string } }>(
    "/approve/:issueKeyPath/r/:revision",
    async (req, reply) => {
      const t = req.query.t ?? "";
      const preview = t ? await previewApproval({ store: ctx.store, rawToken: t }) : { tokenOk: false };
      reply.header("cache-control", "no-store");
      return reply.status(preview.tokenOk ? 200 : 404).send();
    },
  );

  app.post<{
    Params: { issueKeyPath: string; revision: string };
    Body: { t?: string; csrf?: string; action?: string; comment?: string; approverId?: string };
  }>("/approve/:issueKeyPath/r/:revision", async (req, reply) => {
    const body = req.body ?? {};
    const result = await consumeApproval({
      store: ctx.store,
      env: ctx.env,
      config: ctx.config,
      rawToken: body.t ?? "",
      csrf: body.csrf ?? "",
      action: (body.action ?? "") as ApprovalAction,
      comment: body.comment ?? "",
      approverId: body.approverId ?? "",
    });
    return reply
      .status(result.statusCode)
      .type("text/html")
      .send(
        htmlWrap(
          result.ok ? "Recorded" : "Not sent",
          `<p>${escapeHtml(result.message)}</p><p>status=${escapeHtml(result.issueStatus ?? "")}</p>`,
        ),
      );
  });

  app.get<{ Params: { issueKeyPath: string; revision: string }; Querystring: { sig?: string } }>(
    "/archive/:issueKeyPath/r/:revision",
    async (req, reply) => {
      const issueKey = issueKeyFromPath(req.params.issueKeyPath);
      const revision = Number(req.params.revision);
      const issue = await ctx.store.getIssue(issueKey);
      if (!issue || !issue.htmlSha256) return reply.status(404).send("not found");
      const expect = signArchive(ctx.env, issueKey, revision, issue.htmlSha256);
      if (!req.query.sig || req.query.sig !== expect) return reply.status(401).send("bad sig");
      const file = join(
        artifactDirFor(artifactsRoot(ctx.env.ARTIFACT_DIR), issueKey, revision),
        "email.html",
      );
      if (!existsSync(file)) return reply.status(404).send("no artifact");
      return reply.type("text/html").send(readFileSync(file, "utf8"));
    },
  );

  app.get<{ Params: { issueKeyPath: string } }>("/issues/:issueKeyPath", async (req, reply) => {
    if (!workerAuthorized(req, ctx.env)) return reply.status(401).send({ error: "unauthorized" });
    const issue = await ctx.store.getIssue(issueKeyFromPath(req.params.issueKeyPath));
    if (!issue) return reply.status(404).send({ error: "not found" });
    return issue;
  });
}
