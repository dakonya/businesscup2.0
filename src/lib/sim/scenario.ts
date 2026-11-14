import type { Intervention, RunSpec, ScenarioDefinition } from "../contracts";

export const DURATION_MS = 120_000;
export const MAX_ACTIONS = 64;
export const MODEL = Object.freeze({
  dbWorkers: 4, slotsPerReplica: 6, attemptTimeoutMs: 1_000,
  slowdownStartMs: 15_000, slowdownEndMs: 23_000, slowdownFactor: 8,
  arrivalIntervalMs: 125, seriesIntervalMs: 500,
});
const scenario: ScenarioDefinition = {
  id: "catalog-slowdown", title: "Catalog slowdown",
  briefing: "You are on call for a catalog API. Traffic was healthy, but customers are now reporting slow and failed responses. Inspect the timeline and request traces, test a change, then replay the same traffic to compare another decision.",
  learningGoals: ["Distinguish customer outcomes from database attempts.", "Investigate queues, timeouts, and retry amplification.", "Compare interventions under identical external traffic."],
  durationMs: DURATION_MS, checkpointMs: 20_000,
  defaultControls: { apiReplicas: 2, maxAttempts: 3, retryBackoffMs: 50 },
  controls: [
    { type: "set-api-replicas", label: "API replicas", description: "Each replica admits six concurrent attempts. Existing work is retained when scaling down.", values: [1, 2, 4, 8] },
    { type: "set-max-attempts", label: "Maximum attempts", description: "Includes the first attempt. Applied at timeouts and before retry admission.", values: [1, 2, 3] },
    { type: "set-retry-backoff", label: "Retry backoff (ms)", description: "Delay before queuing another attempt. Already scheduled retries keep their due time.", values: [0, 50, 250, 1_000, 2_000] },
  ],
};
export class SimulationInputError extends Error {
  constructor(message: string) { super(message); this.name = "SimulationInputError"; }
}
export function getScenarios(): ScenarioDefinition[] { return [structuredClone(scenario)]; }
export function validateRunSpec(spec: RunSpec, untilMs?: number): void {
  const fail = (message: string): never => { throw new SimulationInputError(message); };
  if (!spec || spec.schemaVersion !== 1 || spec.scenarioId !== scenario.id) fail("Unsupported scenario or schema version.");
  if (!Number.isInteger(spec.seed) || spec.seed < 0 || spec.seed > 0xffff_ffff) fail("Seed must be an integer from 0 to 4294967295.");
  if (!Array.isArray(spec.actions) || spec.actions.length > MAX_ACTIONS) fail(`Actions must be an array with at most ${MAX_ACTIONS} entries.`);
  let previous = -1;
  for (const action of spec.actions) {
    if (!action || !Number.isInteger(action.atMs) || action.atMs < previous || action.atMs < 0 || action.atMs > DURATION_MS) fail("Action times must be ordered integer milliseconds within the scenario.");
    const control = scenario.controls.find(control => control.type === action.type);
    if (!control || !control.values.includes(action.value)) fail("Unsupported intervention or value.");
    previous = action.atMs;
  }
  if (untilMs !== undefined && (!Number.isInteger(untilMs) || untilMs < 0 || untilMs > DURATION_MS)) fail("Replay horizon must be integer milliseconds within the scenario.");
}
export function forkRun(spec: RunSpec, checkpointMs: number): RunSpec {
  validateRunSpec(spec, checkpointMs);
  return { ...spec, actions: spec.actions.filter(action => action.atMs < checkpointMs).map(action => ({ ...action })) };
}
export function controlKey(type: Intervention["type"]): "apiReplicas" | "maxAttempts" | "retryBackoffMs" {
  return type === "set-api-replicas" ? "apiReplicas" : type === "set-max-attempts" ? "maxAttempts" : "retryBackoffMs";
}
