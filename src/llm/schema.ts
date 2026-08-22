import { z } from "zod";
import type { LlmOutput } from "../types";

export const llmOutputSchema = z
  .object({
    subject: z.string().min(1).max(60),
    preheader: z.string().min(1).max(140),
    editorBlurb: z.string().min(1).max(400),
    posts: z
      .array(
        z
          .object({
            id: z.string().min(1),
            summary: z.string().min(1),
            ctaLabel: z.string().min(1),
          })
          .strict(),
      )
      .max(5),
    threats: z
      .array(
        z
          .object({
            id: z.string().min(1),
            whyItMatters: z.string().min(1),
            severity: z.enum(["critical", "high", "medium", "low"]),
          })
          .strict(),
      )
      .max(7),
    briefs: z
      .array(
        z
          .object({
            id: z.string().min(1),
            summary: z.string().min(1),
          })
          .strict(),
      )
      .max(5),
  })
  .strict();

/**
 * The model's output violated the contract in a way the API-side JSON schema
 * could not prevent.
 *
 * Structured outputs only constrain object shape, property names, types,
 * `required` and `additionalProperties`. Verified against @anthropic-ai/sdk
 * 0.120: `maxLength`, `maxItems` and even `enum` are rewritten into a
 * `description` hint before the request is sent, so subject length, the item
 * caps and the severity enum are enforced *here*, not by the model.
 */
export class LlmContractError extends Error {
  override name = "LlmContractError";
}

export function parseLlmJson(raw: unknown): LlmOutput {
  return llmOutputSchema.parse(raw);
}

/**
 * Reject ids the model invented.
 *
 * A JSON schema cannot express "must be one of these runtime ids", and the
 * allow-list is built from exactly the items that went into the prompt — so an
 * id outside it means the model cited a source it was never shown. On a
 * security newsletter that is a fabricated citation, which is the failure this
 * whole QA layer exists to stop. Reject rather than silently drop, so a human
 * sees it via qa_failed.
 */
export function assertIdsAllowed(out: LlmOutput, allowedIds: ReadonlySet<string>): void {
  const unknown = [
    ...out.posts.map((p) => p.id),
    ...out.threats.map((t) => t.id),
    ...out.briefs.map((b) => b.id),
  ].filter((id) => !allowedIds.has(id));
  if (unknown.length) {
    throw new LlmContractError(`model cited ids not in the source allow-list: ${unknown.join(", ")}`);
  }
}

const INJECTION_CANARY = /ignore previous|ignore all previous|system prompt|do not follow/i;

export function llmCanaryFail(out: LlmOutput): string[] {
  const blob = JSON.stringify(out);
  if (INJECTION_CANARY.test(blob)) return ["injection canary: model echoed instruction-override language"];
  return [];
}
