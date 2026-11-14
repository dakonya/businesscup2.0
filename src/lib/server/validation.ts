import { z } from "zod";
import type { CoachRequest } from "../contracts";
import { validateRunSpec } from "../sim/index.ts";
import { DURATION_MS, MAX_ACTIONS } from "../sim/scenario.ts";

const actionSchema = z.discriminatedUnion("type", [
  z.object({ atMs: z.number().int().min(0).max(DURATION_MS), type: z.literal("set-api-replicas"), value: z.number().int() }).strict(),
  z.object({ atMs: z.number().int().min(0).max(DURATION_MS), type: z.literal("set-max-attempts"), value: z.number().int() }).strict(),
  z.object({ atMs: z.number().int().min(0).max(DURATION_MS), type: z.literal("set-retry-backoff"), value: z.number().int() }).strict(),
]);
const runSchema = z.object({ schemaVersion: z.literal(1), scenarioId: z.literal("catalog-slowdown"), seed: z.number().int().min(0).max(0xffff_ffff), actions: z.array(actionSchema).max(MAX_ACTIONS) }).strict();
export const coachRequestSchema = z.object({ mode: z.enum(["hint", "debrief"]), primary: runSchema, comparison: runSchema.optional(), untilMs: z.number().int().min(0).max(DURATION_MS), hintLevel: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional() }).strict().superRefine((value, ctx) => {
  try {
    validateRunSpec(value.primary, value.untilMs);
    if (value.comparison) {
      validateRunSpec(value.comparison, value.untilMs);
      if (value.primary.seed !== value.comparison.seed || value.primary.scenarioId !== value.comparison.scenarioId) throw new Error("Comparison requires identical scenario and seed.");
    }
  } catch {
    ctx.addIssue({ code: "custom", message: "Invalid simulation parameters, action order, or incompatible comparison." });
  }
}) satisfies z.ZodType<CoachRequest>;

// Provider never supplies source/warning; provenance belongs to the server.
export const coachContentSchema = z.object({
  summary: z.string().trim().min(1).max(400),
  observations: z.array(z.object({ text: z.string().trim().min(1).max(500), evidenceEventIds: z.array(z.string().min(1).max(160)).min(1).max(3) }).strict()).min(2).max(3),
  nextExperiment: z.string().trim().min(1).max(300),
  limitations: z.array(z.string().trim().min(1).max(240)).min(1).max(4),
}).strict();
export type CoachContent = z.infer<typeof coachContentSchema>;
