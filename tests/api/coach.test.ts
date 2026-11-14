import { describe, expect, it, vi } from "vitest";
import type { CoachRequest, CoachResponse } from "../../src/lib/contracts";
import { createCoachHandler, MAX_BODY_BYTES } from "../../src/lib/server/coach-handler";
import { buildFacts, rulesCoach } from "../../src/lib/server/facts";
import { createLimiter } from "../../src/lib/server/limits";
import { getScenarios } from "../../src/lib/sim";
import { getCoach, health, type CoachEnv } from "../../src/lib/server/provider";
import { GET as healthRoute } from "../../src/app/api/health/route";
import { POST as coachRoute } from "../../src/app/api/coach/route";

const input: CoachRequest = {
  mode: "debrief", untilMs: 30_000,
  primary: { schemaVersion: 1, scenarioId: "catalog-slowdown", seed: 42, actions: [] },
};
const configured: CoachEnv = { INCIDENTLAB_COACH_MODE: "nvidia", NVIDIA_API_KEY: "fixture-key-not-real", NVIDIA_MODEL: "openai/gpt-oss-120b" };
const facts = buildFacts(input);
const ids = [...facts.allowedIds];
function coachContent(evidenceIds = ids.slice(0, 2)) {
  return {
    summary: "В прогоне есть неуспешные и ожидающие ответа запросы.",
    observations: [
      { text: "Изучи более раннее событие.", evidenceEventIds: [evidenceIds[0]] },
      { text: "Сравни его с более поздним событием.", evidenceEventIds: [evidenceIds[1]] },
    ],
    nextExperiment: "Сравни одну настройку повторов при одинаковом начальном числе и времени.",
    limitations: ["Эта модель упрощает рабочие системы."],
  };
}
function providerResponse(content: unknown = coachContent()) {
  return Response.json({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] });
}
function request(body: unknown = input, headers: HeadersInit = {}) {
  return new Request("http://localhost/api/coach", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}
async function checkFallback(response: Response) {
  expect(response.status).toBe(200);
  const body = await response.json() as CoachResponse;
  expect(body.source).toBe("rules");
  expect(body.warning).toBeTruthy();
  expect(body.observations.length).toBeGreaterThanOrEqual(2);
  return body;
}

describe("coach input, byte limits, and configuration", () => {
  it.each([
    {},
    { ...configured, INCIDENTLAB_COACH_MODE: undefined },
    { ...configured, INCIDENTLAB_COACH_MODE: "rules" },
  ] as CoachEnv[])("keeps default and explicit demo mode local even with provider credentials %#", async env => {
    const fetcher = vi.fn<typeof fetch>();
    const response = await checkFallback(await createCoachHandler({ env, fetcher })(request()));
    expect(response.warning).toBe("Демо-режим: разбор по правилам. Запросы к NVIDIA отключены.");
    expect(response.source).toBe("rules");
    expect(fetcher).not.toHaveBeenCalled();
    expect(health(env).coachConfigured).toBe(false);
  });

  it("rejects an unknown coach mode without contacting a configured provider", async () => {
    const env = { ...configured, INCIDENTLAB_COACH_MODE: "unknown" };
    const fetcher = vi.fn<typeof fetch>();
    const response = await getCoach(input, facts, { env, fetcher });
    expect(response.source).toBe("rules");
    expect(response.warning).toBe("Режим помощника не распознан. Разбор составлен по правилам.");
    expect(fetcher).not.toHaveBeenCalled();
    expect(health(env).coachConfigured).toBe(false);
  });

  it("rejects malformed JSON without contacting the provider", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const handler = createCoachHandler({ env: configured, fetcher });
    const response = await handler(new Request("http://localhost/api/coach", { method: "POST", body: "{" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_JSON" } });
    expect(fetcher).not.toHaveBeenCalled();
    expect((await coachRoute(new Request("http://localhost/api/coach", { method: "POST", body: "{" }))).status).toBe(400);
  });

  it.each([
    null,
    { ...input, mode: "other" },
    { ...input, untilMs: -1 },
    { ...input, untilMs: 120_001 },
    { ...input, untilMs: 1.1 },
    { ...input, hintLevel: 4 },
    { ...input, primary: { ...input.primary, schemaVersion: 2 } },
    { ...input, primary: { ...input.primary, scenarioId: "other" } },
    { ...input, primary: { ...input.primary, seed: -1 } },
    { ...input, primary: { ...input.primary, seed: 4_294_967_296 } },
    { ...input, primary: { ...input.primary, actions: [{ atMs: 20_000, type: "set-max-attempts", value: 4 }] } },
    { ...input, primary: { ...input.primary, actions: [{ atMs: 2, type: "set-max-attempts", value: 1 }, { atMs: 1, type: "set-max-attempts", value: 2 }] } },
    { ...input, primary: { ...input.primary, actions: Array.from({ length: 65 }, () => ({ atMs: 0, type: "set-max-attempts", value: 1 })) } },
    { ...input, comparison: { ...input.primary, seed: 43 } },
    { ...input, metrics: { succeeded: 999_999 } },
    { ...input, primary: { ...input.primary, metrics: { failed: 0 } } },
    { ...input, providerUrl: "https://example.invalid/" },
  ])("rejects invalid client data %# before replay or provider access", async body => {
    const fetcher = vi.fn<typeof fetch>();
    const response = await createCoachHandler({ env: configured, fetcher })(request(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_INPUT" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects an advertised oversized body immediately", async () => {
    const response = await createCoachHandler({ env: {} })(request(input, { "Content-Length": String(MAX_BODY_BYTES + 1) }));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "BODY_TOO_LARGE" } });
  });

  it("bounds actual streamed UTF-8 bytes despite a spoofed small Content-Length", async () => {
    const bytes = new TextEncoder().encode("é".repeat(MAX_BODY_BYTES));
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes.slice(0, 10_000)); controller.enqueue(bytes.slice(10_000)); },
      cancel() { cancelled = true; },
    });
    const streamed = new Request("http://localhost/api/coach", {
      method: "POST", body, headers: { "Content-Length": "1" }, duplex: "half",
    } as RequestInit & { duplex: "half" });
    const response = await createCoachHandler({ env: {} })(streamed);
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
  });

  it("accepts a valid JSON body exactly at the byte boundary", async () => {
    const json = JSON.stringify(input);
    const body = json + " ".repeat(MAX_BODY_BYTES - new TextEncoder().encode(json).byteLength);
    const response = await createCoachHandler({ env: {} })(new Request("http://localhost/api/coach", { method: "POST", body }));
    expect(response.status).toBe(200);
  });

  it("rejects malformed UTF-8 as invalid input without a provider request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const body = new Uint8Array([0xff, 0xfe, 0xfd]);
    const response = await createCoachHandler({ env: configured, fetcher })(new Request("http://localhost/api/coach", { method: "POST", body }));
    expect(response.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    [{}, ["NVIDIA_API_KEY", "NVIDIA_MODEL"]],
    [{ NVIDIA_API_KEY: "fixture-key-not-real" }, ["NVIDIA_MODEL"]],
    [{ NVIDIA_MODEL: configured.NVIDIA_MODEL }, ["NVIDIA_API_KEY"]],
    [{ NVIDIA_API_KEY: " ", NVIDIA_MODEL: " " }, ["NVIDIA_API_KEY", "NVIDIA_MODEL"]],
  ] as Array<[CoachEnv, string[]]>)("uses a deterministic fallback for missing configuration %#", async (env, missing) => {
    const fetcher = vi.fn<typeof fetch>();
    const handler = createCoachHandler({ env: { ...env, INCIDENTLAB_COACH_MODE: "nvidia" }, fetcher });
    const first = await checkFallback(await handler(request()));
    const second = await checkFallback(await handler(request()));
    expect(first).toEqual(second);
    expect(missing.length).toBeGreaterThan(0);
    expect(first.warning).toBe("ИИ-помощник не настроен. Разбор составлен по правилам на основе этого прогона.");
    expect(JSON.stringify(first)).not.toContain("fixture-key-not-real");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports configuration presence without claiming inference health", async () => {
    expect(health({})).toEqual({ status: "ok", contractVersion: 1, coachConfigured: false });
    expect(health(configured)).toEqual({ status: "ok", contractVersion: 1, coachConfigured: true });
    const response = healthRoute();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ status: "ok", contractVersion: 1 });
  });

  it("uses rules when no replay evidence exists", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const response = await createCoachHandler({ env: configured, fetcher })(request({ ...input, untilMs: 0 }));
    const fallback = await checkFallback(response);
    expect(fallback.observations.every(observation => observation.evidenceEventIds.length === 0)).toBe(true);
    expect(fallback.limitations.some(text => text.includes("событий ещё нет"))).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("grounded provider provenance and safe failure", () => {
  it("recomputes both runs, limits evidence, and accepts only supplied namespaced citations", async () => {
    const comparisonInput: CoachRequest = {
      ...input,
      comparison: { ...input.primary, actions: [{ atMs: 20_000, type: "set-max-attempts", value: 1 }] },
    };
    const actual = buildFacts(comparisonInput);
    let posted: Record<string, unknown> | undefined;
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe("https://integrate.api.nvidia.com/v1/chat/completions");
      expect(init!.redirect).toBe("error");
      expect(init!.signal).toBeInstanceOf(AbortSignal);
      const payload = JSON.parse(init!.body as string);
      posted = JSON.parse(payload.messages[1].content);
      expect(payload.reasoning_effort).toBe("low");
      expect(payload.messages[0].content).toContain("must be concise Russian");
      const primaryId = actual.evidence.find(event => event.id.startsWith("primary:"))!.id;
      const comparisonId = actual.evidence.find(event => event.id.startsWith("comparison:"))!.id;
      return providerResponse(coachContent([primaryId, comparisonId]));
    });
    const response = await createCoachHandler({ env: configured, fetcher })(request(comparisonInput));
    expect(response.status).toBe(200);
    const body = await response.json() as CoachResponse;
    expect(body.source).toBe("nvidia");
    expect(body.warning).toBeUndefined();
    expect(posted).toMatchObject({ primary: { metrics: actual.primary.metrics }, comparison: { metrics: actual.comparison!.metrics }, delta: actual.delta });
    expect((posted!.evidence as unknown[]).length).toBeLessThanOrEqual(48);
    expect(JSON.stringify(posted)).not.toContain("fixture-key-not-real");
    expect(body.observations.flatMap(observation => observation.evidenceEventIds).every(id => actual.allowedIds.has(id))).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("grounds the final user instructions in recomputed A/B outcomes and declared control values", async () => {
    const primary: CoachRequest["primary"] = { schemaVersion: 1, scenarioId: "catalog-slowdown", seed: 42, actions: [{ atMs: 20_000, type: "set-api-replicas", value: 4 }] };
    const comparison: CoachRequest["primary"] = { ...primary, actions: [{ atMs: 20_000, type: "set-max-attempts", value: 1 }] };
    const demo: CoachRequest = { mode: "debrief", primary, comparison, untilMs: 120_000 };
    const actual = buildFacts(demo);
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const payload = JSON.parse(init!.body as string);
      const context = JSON.parse(payload.messages[1].content);
      expect(context).not.toHaveProperty("hintLevel");
      expect(context.caseRules).toContain("Pending customers include active operations. Zero API and database queues do not imply zero pending customers.");
      expect(context.outcomeOverview).toContain(`Primary branch at ${demo.untilMs} ms`);
      expect(context.outcomeOverview).toContain(`${actual.primary.metrics.succeeded} succeeded, ${actual.primary.metrics.failed} failed, ${actual.primary.metrics.pending} pending`);
      expect(context.outcomeOverview).toContain(`${actual.comparison!.metrics.succeeded} succeeded, ${actual.comparison!.metrics.failed} failed, ${actual.comparison!.metrics.pending} pending`);
      expect(context.outcomeOverview).toContain(`succeeded ${actual.delta!.succeeded}, failed ${actual.delta!.failed}`);
      expect(context.availableControls).toEqual(getScenarios()[0].controls.map(({ type, label, values }) => ({ type, label, values })));
      expect(Object.keys(context).at(-1)).toBe("responseInstructions");
      expect(context.responseInstructions).toContain("exactly 2 concise observations");
      expect(context.responseInstructions).toContain("Never invent an unsupported control value");
      expect(context.responseInstructions).toContain("No Markdown, backticks, code fences");
      const evidenceIds = [actual.evidence.find(event => event.id.startsWith("primary:"))!.id, actual.evidence.find(event => event.id.startsWith("comparison:"))!.id];
      return providerResponse(coachContent(evidenceIds));
    });
    const response = await getCoach(demo, actual, { env: configured, fetcher });
    expect(response.source).toBe("nvidia");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("requests JSON schema only for an explicitly verified supporting model", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const payload = JSON.parse(init!.body as string);
      expect(payload.response_format).toMatchObject({ type: "json_schema", json_schema: { name: "incidentlab_coach", strict: true } });
      expect(payload.reasoning_effort).toBe("none");
      return providerResponse();
    });
    const result = await getCoach(input, facts, { env: { ...configured, NVIDIA_MODEL: "nvidia/nemotron-3.5-super-vl-120b-a12b" }, fetcher });
    expect(result.source).toBe("nvidia");
  });

  it("uses Russian rules when a valid grounded provider response ignores the requested language", async () => {
    const english = {
      summary: "The replay contains failed and pending customer requests.",
      observations: [
        { text: "Inspect the earlier event.", evidenceEventIds: [ids[0]] },
        { text: "Compare the later event.", evidenceEventIds: [ids[1]] },
      ],
      nextExperiment: "Change one retry control with the same seed and horizon.",
      limitations: ["This is a simplified simulation."],
    };
    const fetcher = vi.fn<typeof fetch>(async () => providerResponse(english));
    const result = await getCoach(input, facts, { env: configured, fetcher });
    expect(result.source).toBe("rules");
    expect(result.warning).toContain("не прошёл проверку");
    expect(result.summary).toMatch(/[А-Яа-яЁё]/);
    expect(result.observations.flatMap(observation => observation.evidenceEventIds).every(id => facts.allowedIds.has(id))).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    "{not JSON}",
    "```json\n" + JSON.stringify(coachContent()) + "\n```",
    "x".repeat(6_001),
    { ...coachContent(), source: "nvidia" },
    { ...coachContent(), summary: "x".repeat(401) },
    { ...coachContent(), summary: "Your readiness score is 99%" },
    { ...coachContent(), observations: coachContent().observations.slice(0, 1) },
    { ...coachContent(), observations: [{ text: "Invented event", evidenceEventIds: ["primary:invented"] }, coachContent().observations[1]] },
    { ...coachContent(), observations: [{ text: "Wrong branch", evidenceEventIds: [`comparison:${ids[0].slice("primary:".length)}`] }, coachContent().observations[1]] },
    { ...coachContent(), observations: [{ text: "No namespace", evidenceEventIds: [ids[0].slice("primary:".length)] }, coachContent().observations[1]] },
    { ...coachContent(), observations: [{ text: "Missing evidence", evidenceEventIds: [] }, coachContent().observations[1]] },
  ])("rejects ungrounded or invalid provider content %# into an honest fallback", async content => {
    const fetcher = vi.fn<typeof fetch>(async () => providerResponse(content));
    const result = await getCoach(input, facts, { env: configured, fetcher });
    expect(result.source).toBe("rules");
    expect(result.warning).toContain("не прошёл проверку");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.observations.flatMap(observation => observation.evidenceEventIds).every(id => facts.allowedIds.has(id))).toBe(true);
  });

  it.each([
    [429, "Лимит запросов"],
    [500, "недоступен"],
    [401, "401"],
    [403, "403"],
  ] as const)("returns HTTP 200 rules fallback for provider status %s without exposing its body", async (status, expectedWarning) => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("private upstream details fixture-key-not-real Invalid JWT serialization: Missing dot delimiter(s)", { status }));
    const result = await checkFallback(await createCoachHandler({ env: configured, fetcher })(request()));
    expect(result.warning).toContain(expectedWarning);
    expect(JSON.stringify(result)).not.toContain("private upstream details");
    expect(JSON.stringify(result)).not.toContain("Invalid JWT serialization");
    expect(JSON.stringify(result)).not.toContain("fixture-key-not-real");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not leak network exception details", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => { throw new Error("fixture-key-not-real secret transport detail"); });
    const result = await getCoach(input, facts, { env: configured, fetcher });
    expect(result.source).toBe("rules");
    expect(result.warning).toContain("недоступен");
    expect(JSON.stringify(result)).not.toContain("fixture-key-not-real");
  });

  it("times out even when a provider ignores AbortSignal, and releases the limiter slot", async () => {
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      signal = init!.signal as AbortSignal;
      return new Promise<Response>(() => {});
    });
    const handler = createCoachHandler({ env: configured, fetcher, timeoutMs: 5, limiter: createLimiter({ concurrent: 1, perClient: 10 }) });
    const result = await checkFallback(await handler(request()));
    expect(result.warning).toContain("не ответил вовремя");
    expect(signal!.aborted).toBe(true);
    const second = await checkFallback(await handler(request()));
    expect(second.warning).toContain("не ответил вовремя");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("includes provider response body reading within the timeout", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({ start() {} })));
    const result = await getCoach(input, facts, { env: configured, fetcher, timeoutMs: 5 });
    expect(result.source).toBe("rules");
    expect(result.warning).toContain("не ответил вовремя");
  });

  it("bounds provider bytes before parsing the completion envelope", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("x".repeat(65_537)));
    const result = await getCoach(input, facts, { env: configured, fetcher });
    expect(result.source).toBe("rules");
    expect(result.warning).toBeTruthy();
  });

  it.each(["http://example.invalid/v1", "https://user:pass@example.invalid/v1", "not a URL", "https://example.invalid/v1?key=value"])("rejects unsafe provider base configuration %s without a fetch", async base => {
    const fetcher = vi.fn<typeof fetch>();
    const result = await getCoach(input, facts, { env: { ...configured, NVIDIA_BASE_URL: base }, fetcher });
    expect(result.source).toBe("rules");
    expect(result.warning).toBe("Не удалось подключить ИИ. Разбор составлен по правилам.");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("self-hosted NVIDIA inference in Brev", () => {
  const brev: CoachEnv = {
    INCIDENTLAB_COACH_MODE: "nvidia",
    NVIDIA_DEPLOYMENT: "brev",
    NVIDIA_API_KEY: "fixture-gateway-token-not-real",
    NVIDIA_MODEL: "nvidia/NVIDIA-Nemotron-Nano-9B-v2",
    NVIDIA_BASE_URL: "https://gateway.example.invalid/v1",
  };
  const provenance = "Модель NVIDIA работает на Brev. Это отдельный сервер, а не hosted API NVIDIA.";

  it("sends a bounded non-thinking vLLM JSON-schema request and keeps honest contract-v1 provenance", async () => {
    const providerLimitations = ["A", "B", "C", "D"].map(label => `${label}: модель упрощает работу сервиса.`);
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe("https://gateway.example.invalid/v1/chat/completions");
      expect(init!.headers).toMatchObject({ Authorization: "Bearer fixture-gateway-token-not-real" });
      expect(init!.redirect).toBe("error");
      const payload = JSON.parse(init!.body as string);
      expect(payload).toMatchObject({ model: brev.NVIDIA_MODEL, stream: false, max_tokens: 800, temperature: 0 });
      expect(payload.response_format).toMatchObject({ type: "json_schema", json_schema: { name: "incidentlab_coach", strict: true, schema: { type: "object" } } });
      expect(payload.messages[0].content).toContain("/no_think");
      expect(payload).not.toHaveProperty("reasoning_effort");
      expect(payload).not.toHaveProperty("chat_template_kwargs");
      expect(init!.body).not.toContain("fixture-gateway-token-not-real");
      return providerResponse({ ...coachContent(), limitations: providerLimitations });
    });
    const response = await createCoachHandler({ env: { ...brev, NVIDIA_API_KEY: ` ${brev.NVIDIA_API_KEY} ` }, fetcher })(request());
    expect(response.status).toBe(200);
    const body = await response.json() as CoachResponse;
    expect(body.source).toBe("nvidia");
    expect(body.warning).toBeUndefined();
    expect(body.limitations).toEqual([provenance, ...providerLimitations.slice(0, 3)]);
    expect(body.observations.flatMap(observation => observation.evidenceEventIds).every(id => facts.allowedIds.has(id))).toBe(true);
    expect(JSON.stringify(body)).not.toContain("fixture-gateway-token-not-real");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("sends at most eight real evidence events per branch and validates only the supplied subset", async () => {
    const primary: CoachRequest["primary"] = { ...input.primary, actions: [{ atMs: 20_000, type: "set-api-replicas", value: 4 }] };
    const demo: CoachRequest = { mode: "debrief", primary, comparison: { ...primary, actions: [{ atMs: 20_000, type: "set-max-attempts", value: 1 }] }, untilMs: 120_000 };
    const actual = buildFacts(demo);
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const payload = JSON.parse(init!.body as string);
      const context = JSON.parse(payload.messages[1].content);
      expect(context).not.toHaveProperty("hintLevel");
      expect(context.allowedEvidenceEventIds).toEqual(context.evidence.map((event: { id: string }) => event.id));
      const schema = payload.response_format.json_schema.schema;
      expect(schema.properties.observations.items.properties.evidenceEventIds.items.enum).toEqual(context.allowedEvidenceEventIds);
      expect(schema.properties.observations.items.properties.evidenceEventIds).toMatchObject({ minItems: 1, maxItems: 3 });
      // The decoder receives the complete schema once; prose does not duplicate its long ID enum.
      expect(payload.messages[0].content).not.toContain("Output schema:");
      expect(payload.messages[0].content).toContain("never into prose");
      for (const namespace of ["primary", "comparison"]) {
        const sent = context.evidence.filter((event: { id: string }) => event.id.startsWith(`${namespace}:`));
        expect(sent.length).toBeLessThanOrEqual(8);
        const firstTwo = actual.evidence.filter(event => event.id.startsWith(`${namespace}:`)).slice(0, 2);
        expect(sent.slice(0, 2)).toEqual(firstTwo);
        expect(sent.every((event: { id: string }) => actual.allowedIds.has(event.id))).toBe(true);
      }
      const omitted = actual.evidence.find(event => !context.allowedEvidenceEventIds.includes(event.id));
      expect(omitted).toBeDefined();
      // It exists in the full replay but was not supplied to the model: reject it.
      return providerResponse(coachContent([omitted!.id, context.allowedEvidenceEventIds[0]]));
    });
    const result = await getCoach(demo, actual, { env: brev, fetcher });
    expect(result.source).toBe("rules");
    expect(result.warning).toContain("не прошёл проверку");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps hint metadata and withholds full case rules in hint requests", async () => {
    const hint: CoachRequest = { ...input, mode: "hint", hintLevel: 2 };
    const actual = buildFacts(hint);
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const context = JSON.parse(JSON.parse(init!.body as string).messages[1].content);
      expect(context.hintLevel).toBe(2);
      expect(context).not.toHaveProperty("caseRules");
      return providerResponse(coachContent(actual.evidence.slice(0, 2).map(event => event.id)));
    });
    expect((await getCoach(hint, actual, { env: brev, fetcher })).source).toBe("nvidia");
  });

  it.each([
    [{ ...brev, NVIDIA_DEPLOYMENT: "other" }, "Неизвестный способ подключения NVIDIA."],
    [{ ...brev, NVIDIA_MODEL: "Qwen/Qwen3-8B" }, "Для Brev нужна модель NVIDIA Nemotron Nano 9B v2."],
    [{ ...brev, NVIDIA_MODEL: "nvidia/unverified-model" }, "Для Brev нужна модель NVIDIA Nemotron Nano 9B v2."],
    [{ ...brev, NVIDIA_BASE_URL: undefined }, "ИИ-помощник не настроен."],
    [{ ...brev, NVIDIA_BASE_URL: "https://integrate.api.nvidia.com/v1" }, "Не удалось подключить ИИ."],
    [{ ...brev, NVIDIA_BASE_URL: "http://localhost:8000/v1" }, "Не удалось подключить ИИ."],
  ] as Array<[CoachEnv, string]>)("fails a misconfigured self-hosted deployment before any provider request %#", async (env, message) => {
    const fetcher = vi.fn<typeof fetch>();
    const result = await getCoach(input, facts, { env, fetcher });
    expect(result.source).toBe("rules");
    expect(result.warning).toContain(message);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not accept valid-looking JSON containing invented references from self-hosted inference", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => providerResponse(coachContent(["primary:invented", "comparison:invented"])));
    const result = await getCoach(input, facts, { env: brev, fetcher });
    expect(result.source).toBe("rules");
    expect(result.warning).toContain("Brev");
    expect(result.warning).toContain("не прошёл проверку");
    expect(result.observations.flatMap(observation => observation.evidenceEventIds).every(id => facts.allowedIds.has(id))).toBe(true);
  });

  it("labels a gateway authentication failure without leaking its body or falling through to hosted NVIDIA", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("fixture-gateway-token-not-real upstream details", { status: 401 }));
    const result = await getCoach(input, facts, { env: brev, fetcher });
    expect(result.source).toBe("rules");
    expect(result.warning).toContain("Brev");
    expect(result.warning).toContain("HTTP 401");
    expect(JSON.stringify(result)).not.toContain("fixture-gateway-token-not-real");
    expect(JSON.stringify(result)).not.toContain("upstream details");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("checks supported deployment configuration presence without claiming a live GPU", () => {
    expect(health(brev)).toEqual({ status: "ok", contractVersion: 1, coachConfigured: true });
    expect(health({ ...brev, NVIDIA_MODEL: "Qwen/Qwen3-8B" }).coachConfigured).toBe(false);
    expect(health({ ...brev, NVIDIA_BASE_URL: undefined }).coachConfigured).toBe(false);
    expect(health({ ...brev, NVIDIA_DEPLOYMENT: "unknown" }).coachConfigured).toBe(false);
  });
});

describe("honest hints and request limiting", () => {
  it("keeps reversed seed-42 outcomes, pending customers and each final queue distinct in rules debrief", () => {
    const scenario = getScenarios()[0];
    const reversed: CoachRequest = {
      mode: "debrief",
      untilMs: scenario.durationMs,
      primary: {
        schemaVersion: 1, scenarioId: scenario.id, seed: 42,
        actions: [{ atMs: scenario.checkpointMs, type: "set-max-attempts", value: 1 }],
      },
      comparison: {
        schemaVersion: 1, scenarioId: scenario.id, seed: 42,
        actions: [{ atMs: scenario.checkpointMs, type: "set-api-replicas", value: 4 }],
      },
    };
    const actual = buildFacts(reversed);
    expect(actual.primary.metrics).toMatchObject({ succeeded: 709, failed: 248, pending: 3, dbQueue: 0 });
    expect(actual.comparison!.metrics).toMatchObject({ succeeded: 120, failed: 800, pending: 40, dbQueue: 1_355 });
    const response = rulesCoach(reversed, actual, "Демо-режим: разбор по правилам. Запросы к NVIDIA отключены.");
    expect(response.source).toBe("rules");
    expect(response.observations[0].text).toContain("успешных — 709, с ошибкой — 248, в ожидании — 3");
    expect(response.observations[1].text).toContain("успешных ответов — 120, ошибок — 800, в ожидании — 40");
    expect(response.observations[1].text).toContain(`успешные ответы ${actual.delta!.succeeded}, ошибки ${actual.delta!.failed}, обращения к базе ${actual.delta!.totalAttempts}`);
    expect(response.observations[2].text).toContain(`В основной попытке повторов — ${actual.primary.metrics.retries}, очередь БД — 0, активных операций — ${actual.primary.metrics.dbActive}`);
    expect(response.observations[2].text).toContain(`В сравниваемой попытке повторов — ${actual.comparison!.metrics.retries}, очередь БД — 1355, активных операций — ${actual.comparison!.metrics.dbActive}`);
    expect(response.observations[2].text).toContain("Таймаут не отменяет работу БД");
    expect(response.observations[2].text).toContain("Пустая очередь не означает, что все запросы уже завершились");
    const references = response.observations.flatMap(observation => observation.evidenceEventIds);
    expect(references.length).toBeGreaterThan(0);
    expect(references.every(id => actual.allowedIds.has(id))).toBe(true);
    expect(new Set(references.map(id => id.split(":")[0]))).toEqual(new Set(["primary", "comparison"]));
  });

  it("keeps first-level fallback hints focused on investigation without exposing a winning setting or mechanism", () => {
    const hint: CoachRequest = { ...input, mode: "hint", hintLevel: 1 };
    const hintFacts = buildFacts(hint);
    const response = rulesCoach(hint, hintFacts, "Fixture fallback.");
    expect(JSON.stringify(response)).not.toMatch(/максимум попыток \d|тайм-аут|повторн.{0,20}обращен|slowdownFactor|первопричин|агрессивные повторы/i);
    expect(response.nextExperiment).toContain("изучи");
    expect(hintFacts.evidence.every(event => ["arrival", "request-succeeded", "request-failed", "intervention"].includes(event.kind))).toBe(true);
    const level2: CoachRequest = { ...hint, hintLevel: 2 };
    expect(rulesCoach(level2, buildFacts(level2), "Fixture fallback.").nextExperiment).not.toContain("максимум попыток 1");
    const level3: CoachRequest = { ...hint, hintLevel: 3 };
    expect(rulesCoach(level3, buildFacts(level3), "Fixture fallback.").nextExperiment).toContain("максимум попыток 1");
  });

  it("returns a genuine HTTP 429 for exhausted per-client budget, without charging invalid input", async () => {
    const handler = createCoachHandler({ env: {}, limiter: createLimiter({ perClient: 1, global: 10 }) });
    expect((await handler(request({ ...input, untilMs: -1 }))).status).toBe(400);
    expect((await handler(request(input, { "x-forwarded-for": "192.0.2.1, 192.0.2.2" }))).status).toBe(200);
    const limited = await handler(request(input, { "x-forwarded-for": "192.0.2.1" }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
    expect(await limited.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
    expect((await handler(request(input, { "x-forwarded-for": "192.0.2.3" }))).status).toBe(200);
  });

  it("limits simultaneous provider requests and admits work again after completion", async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => new Promise<Response>(resolve => { finish = resolve; }))
      .mockImplementation(async () => providerResponse());
    const handler = createCoachHandler({ env: configured, fetcher, limiter: createLimiter({ concurrent: 1, perClient: 10 }) });
    const first = handler(request());
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect((await handler(request())).status).toBe(429);
    finish(providerResponse());
    expect((await first).status).toBe(200);
    expect((await handler(request())).status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("retains global and active budgets across clients, resets windows, and releases idempotently", () => {
    let now = 0;
    const limiter = createLimiter({ concurrent: 1, perClient: 2, global: 2, windowMs: 100, now: () => now });
    const release = limiter.acquire("one")!;
    expect(limiter.acquire("two")).toBeUndefined();
    release(); release();
    const release2 = limiter.acquire("two")!;
    release2();
    expect(limiter.acquire("three")).toBeUndefined();
    now = 100;
    const release3 = limiter.acquire("three")!;
    expect(typeof release3).toBe("function");
    now = 200;
    expect(limiter.acquire("four")).toBeUndefined();
    release3();
    expect(typeof limiter.acquire("four")).toBe("function");
  });

  it("bounds distinct client bookkeeping even with an expanded global request budget", () => {
    const limiter = createLimiter({ perClient: 2, global: 2_000, concurrent: 1 });
    for (let index = 0; index < 1_000; index++) {
      const release = limiter.acquire(`client-${index}`);
      expect(typeof release).toBe("function");
      release!();
    }
    expect(limiter.acquire("one-more-client")).toBeUndefined();
    expect(typeof limiter.acquire("client-0")).toBe("function");
  });
});
