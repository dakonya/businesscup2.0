import { z } from "zod";
import type { CoachRequest, CoachResponse, HealthResponse } from "../contracts";
import type { Facts } from "./facts";
import { getScenarios } from "../sim";
import { rulesCoach } from "./facts";
import { readBoundedBody } from "./http";
import { coachContentSchema } from "./validation";

export type CoachEnv = { NVIDIA_API_KEY?: string; NVIDIA_BASE_URL?: string; NVIDIA_MODEL?: string; NVIDIA_DEPLOYMENT?: string; INCIDENTLAB_COACH_MODE?: string };
const BREV_MODEL = "nvidia/NVIDIA-Nemotron-Nano-9B-v2";
const BREV_PROVENANCE = "Модель NVIDIA работает на Brev. Это отдельный сервер, а не hosted API NVIDIA.";
export function serverEnv(): CoachEnv {
  return { NVIDIA_API_KEY: process.env.NVIDIA_API_KEY, NVIDIA_BASE_URL: process.env.NVIDIA_BASE_URL, NVIDIA_MODEL: process.env.NVIDIA_MODEL, NVIDIA_DEPLOYMENT: process.env.NVIDIA_DEPLOYMENT, INCIDENTLAB_COACH_MODE: process.env.INCIDENTLAB_COACH_MODE };
}
export function health(env: CoachEnv = serverEnv()): HealthResponse {
  const deployment = env.NVIDIA_DEPLOYMENT?.trim() || "hosted";
  const supported = deployment === "hosted" || deployment === "brev" && env.NVIDIA_MODEL?.trim() === BREV_MODEL && Boolean(env.NVIDIA_BASE_URL?.trim());
  return { status: "ok", contractVersion: 1, coachConfigured: Boolean(env.INCIDENTLAB_COACH_MODE?.trim() === "nvidia" && env.NVIDIA_API_KEY?.trim() && env.NVIDIA_MODEL?.trim() && supported) };
}
export async function getCoach(input: CoachRequest, facts: Facts, options: { env?: CoachEnv; fetcher?: typeof fetch; timeoutMs?: number } = {}): Promise<CoachResponse> {
  const env = options.env ?? serverEnv();
  const mode = env.INCIDENTLAB_COACH_MODE?.trim() || "rules";
  if (mode !== "nvidia") return rulesCoach(input, facts, mode === "rules"
    ? "Демо-режим: разбор по правилам. Запросы к NVIDIA отключены."
    : "Режим помощника не распознан. Разбор составлен по правилам.");
  const deployment = env.NVIDIA_DEPLOYMENT?.trim() || "hosted";
  if (deployment !== "hosted" && deployment !== "brev") return rulesCoach(input, facts, "Неизвестный способ подключения NVIDIA. Разбор составлен по правилам.");
  const isBrev = deployment === "brev";
  const model = env.NVIDIA_MODEL?.trim();
  const missing = [!env.NVIDIA_API_KEY?.trim() && "NVIDIA_API_KEY", !model && "NVIDIA_MODEL", isBrev && !env.NVIDIA_BASE_URL?.trim() && "NVIDIA_BASE_URL"].filter(Boolean);
  if (missing.length) return rulesCoach(input, facts, "ИИ-помощник не настроен. Разбор составлен по правилам на основе этого прогона.");
  if (isBrev && model !== BREV_MODEL) return rulesCoach(input, facts, "Для Brev нужна модель NVIDIA Nemotron Nano 9B v2. Разбор составлен по правилам.");
  if (facts.evidence.length < 2) return rulesCoach(input, facts, "Пока недостаточно событий для ответа ИИ. Разбор составлен по правилам.");
  let base: URL;
  try {
    base = new URL((env.NVIDIA_BASE_URL?.trim() || "https://integrate.api.nvidia.com/v1").replace(/\/$/, "") + "/chat/completions");
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new Error();
    if (isBrev && base.hostname === "integrate.api.nvidia.com") throw new Error();
  } catch { return rulesCoach(input, facts, "Не удалось подключить ИИ. Разбор составлен по правилам."); }
  const evidence = isBrev ? ["primary", "comparison"].flatMap(namespace => {
    const branch = facts.evidence.filter(event => event.id.startsWith(`${namespace}:`));
    const selected = branch.slice(0, 2);
    for (const kind of ["intervention", "db-slowdown", "db-recovered", "attempt-timeout", "late-response", "request-failed", "retry-scheduled"]) {
      const event = branch.find(candidate => candidate.kind === kind);
      if (event && !selected.some(candidate => candidate.id === event.id)) selected.push(event);
    }
    return selected.slice(0, 8);
  }) : facts.evidence;
  const allowedEvidenceEventIds = evidence.map(event => event.id);
  const allowedEvidenceIds = new Set(allowedEvidenceEventIds);
  const caseRules = [
    "Customer states and queue sizes are different measurements: arrived = succeeded + failed + pending.",
    "Succeeded, failed and pending are mutually exclusive customer states. Failed customers are terminal, not part of pending or unresolved customers; never describe pending as including failed customers.",
    "Pending customers include active operations. Zero API and database queues do not imply zero pending customers.",
    "An attempt timeout releases an API waiting slot but does not cancel queued or active database work. Its late result cannot rescue that timed-out attempt.",
    "Requests waiting in the API queue have no end-to-end deadline in this model and remain pending until an actual attempt outcome.",
    "A final database queue of zero means no queued database work remains in that branch at the horizon. Never describe queue persistence or buildup in a branch whose final queue is zero. Active work and pending customers may still remain.",
  ];
  const describeOutcomes = (label: string, metrics: Facts["primary"]["metrics"]) =>
    `${label} at ${input.untilMs} ms: ${metrics.arrived} arrived, ${metrics.succeeded} succeeded, ${metrics.failed} failed, ${metrics.pending} pending; ${metrics.totalAttempts} database attempts including ${metrics.retries} retries; final API queue ${metrics.apiQueue}, final database queue ${metrics.dbQueue}.`;
  const outcomeOverview = [
    describeOutcomes("Primary branch", facts.primary.metrics),
    ...(facts.comparison ? [describeOutcomes("Comparison branch", facts.comparison.metrics)] : []),
    ...(facts.delta ? [`Comparison minus primary: succeeded ${facts.delta.succeeded}, failed ${facts.delta.failed}, database attempts ${facts.delta.totalAttempts}.`] : []),
    "These are same-horizon outcomes. An intervention timestamp alone is not a before/after performance measurement.",
  ].join(" ");
  const availableControls = getScenarios().find(scenario => scenario.id === input.primary.scenarioId)!.controls.map(({ type, label, values }) => ({ type, label, values }));
  const responseInstructions = [
    "Your response must be exactly one bare JSON object. Its first character must be { and its last character must be }. No Markdown, backticks, code fences, or text outside JSON.",
    facts.comparison
      ? "Write exactly 2 concise observations. First compare the actual primary and comparison customer outcomes at the same horizon, preserving succeeded, failed and pending separately. Second cite the queue/retry evidence." + (input.mode === "hint" ? " Respect the current hint level; in early hints, direct investigation instead of revealing the mechanism." : " This is a full debrief, not a hint.")
      : "Write 2 or 3 concise observations supported by supplied metrics and evidence." + (input.mode === "hint" ? " Respect the current hint level." : " This is a full debrief, not a hint."),
    "Do not infer improvement merely from an intervention timestamp. Quote outcomeOverview accurately; do not invent a baseline or unobserved success rate. Quote the actual pending counts; never claim zero pending when the supplied count is nonzero. Copy evidence IDs byte-for-byte from allowedEvidenceEventIds, preserving the branch namespace. Never construct event IDs from metric names or values.",
    "Describe queue persistence separately for each branch, using its actual final queue size; never say both branches have persistent queues if either final queue is zero.",
    "Limitations must describe simulation assumptions and the successful-only latency bias. Do not introduce outcome comparisons or new metric claims in limitations. Check the numerical direction of every comparison: a smaller p95 value cannot be described as higher latency.",
    "Give exactly one next experiment using one intervention type and one value listed in availableControls. Keep the same seed and comparison horizon. Frame it as a hypothesis to test, not a promised improvement or an already measured result. Never invent an unsupported control value.",
  ].join(" ");
  const responseSchema = z.toJSONSchema(coachContentSchema);
  if (isBrev) {
    // Restrict generation to IDs actually included in this request; never manufacture evidence.
    const observations = responseSchema.properties!.observations as { items: { properties: { evidenceEventIds: { items: { enum?: string[] } } } } };
    observations.items.properties.evidenceEventIds.items.enum = allowedEvidenceEventIds;
  }
  const languageInstructions = "All user-facing text (summary, observations.text, nextExperiment, limitations) must be concise Russian. Keep schema keys and evidence event IDs unchanged. Use plain, natural Russian. Address the learner informally as ты when giving an instruction. Write connected, concrete explanations, without marketing language, metaphors, slang, or terse slogans. Keep every claim grounded in the supplied facts.";
  const prompt = isBrev ? [
    "/no_think",
    "You are IncidentLab's grounded training coach. Return one bare JSON object matching the response schema. No Markdown. Be brief: summary under 35 words, each observation under 25 words, each limitation under 20 words.",
    languageInstructions,
    "Use only the supplied metrics and events. Succeeded, failed and pending are separate states. A zero final queue means no queued work remains, not zero pending. Compare branches at the same horizon; do not invent before/after changes.",
    "Write exactly two observations. Compare customer outcomes, then queue/retry behavior. Copy supplied event IDs only into evidenceEventIds, never into prose. Do not invent IDs, numbers or causal guarantees.",
    input.mode === "hint" ? `Hint level ${input.hintLevel ?? 1}: level 1 asks for inspection without mechanism or winning settings; level 2 points to timing without a winning value; level 3 suggests one experiment.` : "Explain the observed queue/retry mechanism concisely.",
    "Suggest one future experiment using an available control value. Name the starting branch and frame it as a hypothesis, not a promise. Limitations describe simulation assumptions and latency statistics covering successes only. Do not compare branch outcomes in limitations.",
  ].join("\n") : [
    "You are IncidentLab's grounded on-call training coach. Return exactly one bare JSON object matching the supplied schema. Do not use Markdown, backticks or code fences. Put every explanation inside the JSON object.",
    languageInstructions,
    "Use only supplied replay facts. Provide 2 or 3 observations, each citing 1-3 supplied event IDs with their primary: or comparison: namespace. Cite only supplied IDs. Do not invent measurements or readiness scores, personality diagnoses, or employment predictions. Never change the simulation.",
    input.mode === "hint" ? `Hint mode level ${input.hintLevel ?? 1}. Level 1: ask the learner to inspect outcomes and traces; do not reveal the root cause or a winning setting. Level 2: point to timing and retry evidence without giving a winning value. Level 3: suggest one testable control change. Do not disclose mechanics beyond the current hint level.` : "Debrief mode: explain observed queueing and retry mechanisms, distinguish attempted operations from unique customers, and pending from failed.",
    "Offer exactly one next experiment. State the simulation's limits and successful-only latency bias. Evidence IDs support observations; numeric totals come from metrics, never estimates.",
    `Output schema: ${JSON.stringify(responseSchema)}`,
  ].join("\n");
  const payload: Record<string, unknown> = {
    model, stream: false, max_tokens: isBrev ? 800 : 1_200, temperature: isBrev ? 0 : 0.2,
    messages: [{ role: "system", content: prompt }, { role: "user", content: JSON.stringify({ mode: input.mode, ...(input.mode === "hint" ? { hintLevel: input.hintLevel ?? 1 } : {}), ...(input.mode === "debrief" ? { caseRules } : {}), untilMs: input.untilMs, outcomeOverview, availableControls, primary: { metrics: facts.primary.metrics, controls: facts.primary.controls }, ...(facts.comparison ? { comparison: { metrics: facts.comparison.metrics, controls: facts.comparison.controls }, delta: facts.delta } : {}), evidence, allowedEvidenceEventIds, ...(!isBrev ? { responseInstructions } : {}) }) }],
  };
  // Nano 9B's published chat template uses /no_think; reasoning_effort and Qwen-style kwargs do not disable it.
  // The pinned Brev deployment explicitly enables experimental V1 for NemotronH, with FlashInfer and no prefix cache.
  // Its JSON grammar restricts evidence to the sent IDs; strict Zod and ID-subset validation remain authoritative.
  if (isBrev || model === "nvidia/nemotron-3.5-super-vl-120b-a12b") {
    payload.response_format = { type: "json_schema", json_schema: { name: "incidentlab_coach", strict: true, schema: responseSchema } };
    if (!isBrev) payload.reasoning_effort = "none";
  } else if (model === "openai/gpt-oss-120b" || model === "openai/gpt-oss-20b") payload.reasoning_effort = "low";
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Race includes body parsing; a provider that ignores abort still cannot hold this request open.
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, options.timeoutMs ?? 18_000); });
    const result = await Promise.race([timeout, (async () => {
      const response = await (options.fetcher ?? fetch)(base, { method: "POST", redirect: "error", cache: "no-store", signal: controller.signal, headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.NVIDIA_API_KEY!.trim()}` }, body: JSON.stringify(payload) });
      if (!response.ok) {
        const reason = response.status === 401 ? "authentication" : response.status === 403 ? "access-denied" : response.status === 429 ? "rate-limited" : "unavailable";
        throw new Error(reason);
      }
      const raw = JSON.parse(await readBoundedBody(response.body, 65_536));
      const content = raw?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.length > 6_000) throw new Error("invalid");
      const parsed = coachContentSchema.safeParse(JSON.parse(content));
      if (!parsed.success || parsed.data.observations.some(o => o.evidenceEventIds.some(id => !allowedEvidenceIds.has(id)))) throw new Error("invalid");
      const userText = [parsed.data.summary, ...parsed.data.observations.map(o => o.text), parsed.data.nextExperiment, ...parsed.data.limitations];
      if (userText.some(text => !/[А-Яа-яЁё]/.test(text))) throw new Error("invalid");
      // Reject forbidden categories even when syntactically valid. This is a conservative check, not semantic fact verification.
      if (/readiness\s*(score|percentage)|\b\d+\s*%|employability|personality diagnosis/i.test(JSON.stringify(parsed.data))) throw new Error("invalid");
      const limitations = isBrev ? [BREV_PROVENANCE, ...parsed.data.limitations.filter(text => text !== BREV_PROVENANCE)].slice(0, 4) : parsed.data.limitations;
      return { source: "nvidia" as const, ...parsed.data, limitations };
    })()]);
    return result;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unavailable";
    const warning = reason === "timeout" || controller.signal.aborted ? "ИИ не ответил вовремя. Разбор составлен по правилам." : reason === "authentication" ? "NVIDIA отклонила авторизацию (HTTP 401). Разбор составлен по правилам." : reason === "access-denied" ? "NVIDIA запретила доступ (HTTP 403). Разбор составлен по правилам." : reason === "rate-limited" ? "Лимит запросов к ИИ исчерпан. Разбор составлен по правилам." : reason === "invalid" || error instanceof SyntaxError ? "Ответ ИИ не прошёл проверку. Разбор составлен по правилам." : "ИИ недоступен. Разбор составлен по правилам.";
    return rulesCoach(input, facts, isBrev ? `Сервер Brev: ${warning}` : warning);
  } finally { if (timer) clearTimeout(timer); }
}
