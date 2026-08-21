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
  })
  .strict();

export function parseLlmJson(raw: unknown): LlmOutput {
  return llmOutputSchema.parse(raw);
}

const INJECTION_CANARY = /ignore previous|ignore all previous|system prompt|do not follow/i;

export function llmCanaryFail(out: LlmOutput): string[] {
  const blob = JSON.stringify(out);
  if (INJECTION_CANARY.test(blob)) return ["injection canary: model echoed instruction-override language"];
  return [];
}
