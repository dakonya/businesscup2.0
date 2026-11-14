import { z } from "zod";
import type { CoachRequest, CoachResponse, HealthResponse } from "../contracts";
import type { Facts } from "./facts";
import { rulesCoach } from "./facts";
import { readBoundedBody } from "./http";
import { coachContentSchema } from "./validation";

export type CoachEnv = { NVIDIA_API_KEY?: string; NVIDIA_BASE_URL?: string; NVIDIA_MODEL?: string };
export function serverEnv(): CoachEnv {
  return { NVIDIA_API_KEY: process.env.NVIDIA_API_KEY, NVIDIA_BASE_URL: process.env.NVIDIA_BASE_URL, NVIDIA_MODEL: process.env.NVIDIA_MODEL };
}
export function health(env: CoachEnv = serverEnv()): HealthResponse {
  return { status: "ok", contractVersion: 1, coachConfigured: Boolean(env.NVIDIA_API_KEY?.trim() && env.NVIDIA_MODEL?.trim()) };
}
export async function getCoach(input: CoachRequest, facts: Facts, options: { env?: CoachEnv; fetcher?: typeof fetch; timeoutMs?: number } = {}): Promise<CoachResponse> {
  const env = options.env ?? serverEnv();
  const missing = [!env.NVIDIA_API_KEY?.trim() && "NVIDIA_API_KEY", !env.NVIDIA_MODEL?.trim() && "NVIDIA_MODEL"].filter(Boolean);
  if (missing.length) return rulesCoach(input, facts, `Missing configuration: ${missing.join(", ")}.`);
  if (facts.evidence.length < 2) return rulesCoach(input, facts, "Not enough trace evidence yet for a grounded provider response.");
  let base: URL;
  try {
    base = new URL((env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1").replace(/\/$/, "") + "/chat/completions");
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new Error();
  } catch { return rulesCoach(input, facts, "NVIDIA_BASE_URL is invalid."); }
  const prompt = [
    "You are IncidentLab's grounded on-call training coach. Return only JSON matching the supplied schema, in concise English.",
    "Use only supplied replay facts. Provide 2 or 3 observations, each citing 1-3 supplied event IDs with their primary: or comparison: namespace. Cite only supplied IDs. Do not invent measurements or readiness scores, personality diagnoses, or employment predictions. Never change the simulation.",
    input.mode === "hint" ? `Hint mode level ${input.hintLevel ?? 1}. Level 1: ask the learner to inspect outcomes and traces; do not reveal the root cause or a winning setting. Level 2: point to timing and retry evidence without giving a winning value. Level 3: suggest one testable control change. Do not disclose mechanics beyond the current hint level.` : "Debrief mode: explain observed queueing and retry mechanisms, distinguish attempted operations from unique customers, and pending from failed.",
    "Offer exactly one next experiment. State the simulation's limits and successful-only latency bias. Evidence IDs support observations; numeric totals come from metrics, never estimates.",
    `Output schema: ${JSON.stringify(z.toJSONSchema(coachContentSchema))}`,
  ].join("\n");
  const payload: Record<string, unknown> = {
    model: env.NVIDIA_MODEL, stream: false, max_tokens: 1_200, temperature: 0.2,
    messages: [{ role: "system", content: prompt }, { role: "user", content: JSON.stringify({ mode: input.mode, hintLevel: input.hintLevel ?? 1, untilMs: input.untilMs, primary: { metrics: facts.primary.metrics, controls: facts.primary.controls }, ...(facts.comparison ? { comparison: { metrics: facts.comparison.metrics, controls: facts.comparison.controls }, delta: facts.delta } : {}), evidence: facts.evidence }) }],
  };
  // Hosted support verified in NVIDIA's model-specific reference; other models use JSON prompting + the same strict validation.
  if (env.NVIDIA_MODEL === "nvidia/nemotron-3.5-super-vl-120b-a12b") {
    payload.response_format = { type: "json_schema", json_schema: { name: "incidentlab_coach", strict: true, schema: z.toJSONSchema(coachContentSchema) } };
    payload.reasoning_effort = "none";
  } else if (env.NVIDIA_MODEL === "openai/gpt-oss-120b" || env.NVIDIA_MODEL === "openai/gpt-oss-20b") payload.reasoning_effort = "low";
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Race includes body parsing; a provider that ignores abort still cannot hold this request open.
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, options.timeoutMs ?? 18_000); });
    const result = await Promise.race([timeout, (async () => {
      const response = await (options.fetcher ?? fetch)(base, { method: "POST", redirect: "error", cache: "no-store", signal: controller.signal, headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.NVIDIA_API_KEY}` }, body: JSON.stringify(payload) });
      if (!response.ok) throw new Error(response.status === 429 ? "rate-limited" : "unavailable");
      const raw = JSON.parse(await readBoundedBody(response.body, 65_536));
      const content = raw?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.length > 6_000) throw new Error("invalid");
      const parsed = coachContentSchema.safeParse(JSON.parse(content));
      if (!parsed.success || parsed.data.observations.some(o => o.evidenceEventIds.some(id => !facts.allowedIds.has(id)))) throw new Error("invalid");
      // Reject forbidden categories even when syntactically valid. This is a conservative check, not semantic fact verification.
      if (/readiness\s*(score|percentage)|\b\d+\s*%|employability|personality diagnosis/i.test(JSON.stringify(parsed.data))) throw new Error("invalid");
      return { source: "nvidia" as const, ...parsed.data };
    })()]);
    return result;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unavailable";
    const warning = reason === "timeout" || controller.signal.aborted ? "NVIDIA timed out; showing a deterministic rules analysis." : reason === "rate-limited" ? "NVIDIA rate limit reached; showing a deterministic rules analysis." : reason === "invalid" || error instanceof SyntaxError ? "NVIDIA returned an invalid response; showing a deterministic rules analysis." : "NVIDIA is unavailable; showing a deterministic rules analysis.";
    return rulesCoach(input, facts, warning);
  } finally { if (timer) clearTimeout(timer); }
}
