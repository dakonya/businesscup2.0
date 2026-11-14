import type { ComparisonView, Controls, Intervention, RequestSummary, RunMetrics, RunSpec, RunView, TimePoint, TraceEvent } from "../contracts";
import { EventHeap } from "./heap.ts";
import { controlKey, DURATION_MS, getScenarios, MODEL, SimulationInputError, validateRunSpec } from "./scenario.ts";
export { getScenarios, SimulationInputError, validateRunSpec, forkRun } from "./scenario.ts";

type RequestState = RequestSummary;
type Attempt = { id: string; request: RequestState; awaiting: boolean };
type Event = { atMs: number; priority: number; sequence: number } & (
  | { type: "action"; action: Intervention }
  | { type: "arrival"; id: string }
  | { type: "complete" | "timeout"; attempt: Attempt }
  | { type: "retry"; request: RequestState }
  | { type: "slowdown-start" | "slowdown-end" | "sample" | "pump" }
);
type WithoutSequence<T> = T extends unknown ? Omit<T, "sequence"> : never;
type EventInput = WithoutSequence<Event>;
// Randomness is a function of seed + stable identity, never event processing order.
function hash(seed: number, identity: string): number {
  let value = (seed ^ 0x811c9dc5) >>> 0;
  for (let i = 0; i < identity.length; i++) value = Math.imul(value ^ identity.charCodeAt(i), 0x01000193) >>> 0;
  value ^= value >>> 16; value = Math.imul(value, 0x7feb352d); value ^= value >>> 15;
  return value >>> 0;
}
export function simulateRun(spec: RunSpec, untilMs: number): RunView {
  validateRunSpec(spec, untilMs);
  const controls: Controls = { ...getScenarios()[0].defaultControls };
  const heap = new EventHeap<Event>(); let sequence = 0; let now = 0;
  const events: TraceEvent[] = []; const requests: RequestState[] = []; const series: TimePoint[] = [];
  const apiQueue: RequestState[] = []; let apiHead = 0;
  const dbQueue: Attempt[] = []; let dbHead = 0;
  let apiActive = 0; let dbActive = 0; let succeeded = 0; let failed = 0; let totalAttempts = 0; let retries = 0;
  const add = (event: EventInput) => heap.push({ ...event, sequence: sequence++ } as Event);
  const trace = (kind: string, message: string, request?: RequestState, attempt?: Attempt, data?: TraceEvent["data"]) => {
    // Stable causal identity; unaffected by horizon-dependent sampling or another branch's unrelated events.
    const id = `${kind}:${attempt?.id ?? request?.id ?? now}:${kind === "intervention" ? events.filter(e => e.kind === "intervention").length : 0}`;
    events.push({ id, atMs: now, kind, message, ...(request ? { requestId: request.id } : {}), ...(attempt ? { attemptId: attempt.id } : {}), ...(data ? { data } : {}) });
  };
  const fail = (request: RequestState) => {
    if (request.status !== "pending") return;
    request.status = "failed"; failed++;
    trace("request-failed", "Customer response was lost after the attempt budget was exhausted.", request);
  };
  const pumpDb = () => {
    while (dbActive < MODEL.dbWorkers && dbHead < dbQueue.length) {
      const attempt = dbQueue[dbHead++]; dbActive++;
      const baseMs = 300 + hash(spec.seed, `service:${attempt.id}`) % 101;
      const slow = now >= MODEL.slowdownStartMs && now < MODEL.slowdownEndMs;
      const serviceMs = baseMs * (slow ? MODEL.slowdownFactor : 1);
      trace("db-start", "Database worker started an operation.", attempt.request, attempt, { serviceMs, dbActive, dbQueue: dbQueue.length - dbHead });
      add({ type: "complete", atMs: now + serviceMs, priority: 2, attempt });
    }
  };
  const pumpApi = () => {
    while (apiActive < controls.apiReplicas * MODEL.slotsPerReplica && apiHead < apiQueue.length) {
      const request = apiQueue[apiHead++];
      if (request.status !== "pending") continue;
      if (request.attempts >= controls.maxAttempts) { fail(request); continue; }
      request.attempts++; totalAttempts++; if (request.attempts > 1) retries++;
      const attempt: Attempt = { id: `${request.id}/a${request.attempts}`, request, awaiting: true };
      apiActive++; dbQueue.push(attempt);
      trace("attempt-created", "API admitted an attempt to the database queue.", request, attempt, { attemptNumber: request.attempts, apiActive, dbQueue: dbQueue.length - dbHead });
      add({ type: "timeout", atMs: now + MODEL.attemptTimeoutMs, priority: 3, attempt });
      pumpDb();
    }
  };
  for (const action of spec.actions) add({ type: "action", atMs: action.atMs, priority: 0, action });
  add({ type: "slowdown-start", atMs: MODEL.slowdownStartMs, priority: 1 });
  add({ type: "slowdown-end", atMs: MODEL.slowdownEndMs, priority: 1 });
  for (let i = 0; ; i++) {
    const id = `r${i.toString().padStart(4, "0")}`;
    const atMs = 80 + i * MODEL.arrivalIntervalMs + hash(spec.seed, `arrival:${id}`) % 41;
    if (atMs > DURATION_MS) break;
    add({ type: "arrival", atMs, priority: 5, id });
  }
  for (let atMs = 0; atMs < untilMs; atMs += MODEL.seriesIntervalMs) add({ type: "sample", atMs, priority: 6 });
  add({ type: "sample", atMs: untilMs, priority: 6 });
  for (let event = heap.pop(); event && event.atMs <= untilMs; event = heap.pop()) {
    now = event.atMs;
    switch (event.type) {
      case "action":
        controls[controlKey(event.action.type)] = event.action.value;
        trace("intervention", `${event.action.type} set to ${event.action.value}.`, undefined, undefined, { type: event.action.type, value: event.action.value });
        // Admit only after all same-time controls have been applied, including scale up then down.
        add({ type: "pump", atMs: now, priority: 4 });
        break;
      case "arrival": {
        const request: RequestState = { id: event.id, arrivedAtMs: now, status: "pending", attempts: 0, latencyMs: null };
        requests.push(request); apiQueue.push(request);
        trace("arrival", "A new customer request arrived.", request); pumpApi(); break;
      }
      case "complete": {
        const { attempt } = event; dbActive--;
        trace("db-complete", "Database operation completed.", attempt.request, attempt);
        if (attempt.awaiting && attempt.request.status === "pending") {
          attempt.awaiting = false; apiActive--; attempt.request.status = "succeeded";
          attempt.request.latencyMs = now - attempt.request.arrivedAtMs; succeeded++;
          trace("request-succeeded", "Customer received a successful response.", attempt.request, attempt, { latencyMs: attempt.request.latencyMs });
        } else {
          trace("late-response", "Database work finished after its response deadline; the result was discarded.", attempt.request, attempt);
        }
        pumpDb(); pumpApi(); break;
      }
      case "timeout": {
        const { attempt } = event;
        if (!attempt.awaiting) break;
        attempt.awaiting = false; apiActive--;
        trace("attempt-timeout", "API stopped waiting; queued or active database work was not cancelled.", attempt.request, attempt, { dbQueue: dbQueue.length - dbHead, dbActive });
        if (attempt.request.attempts >= controls.maxAttempts) fail(attempt.request);
        else {
          const retryAtMs = now + controls.retryBackoffMs;
          trace("retry-scheduled", "A retry was scheduled using the current backoff.", attempt.request, attempt, { retryAtMs });
          add({ type: "retry", atMs: retryAtMs, priority: 4, request: attempt.request });
        }
        pumpApi(); break;
      }
      case "pump": pumpApi(); break;
      case "retry":
        if (event.request?.status === "pending") apiQueue.push(event.request);
        pumpApi(); break;
      case "slowdown-start": trace("db-slowdown", "Database operations starting now require more service time.", undefined, undefined, { factor: MODEL.slowdownFactor }); break;
      case "slowdown-end": trace("db-recovered", "New database operations have returned to normal service time. Existing work remains queued."); break;
      case "sample":
        series.push({ atMs: now, succeeded, failed, pending: requests.length - succeeded - failed, totalAttempts, apiQueue: apiQueue.length - apiHead, dbQueue: dbQueue.length - dbHead }); break;
    }
  }
  const latencies = requests.flatMap(r => r.latencyMs === null ? [] : [r.latencyMs]).sort((a, b) => a - b);
  const metrics: RunMetrics = {
    arrived: requests.length, succeeded, failed, pending: requests.length - succeeded - failed, totalAttempts, retries,
    apiQueue: apiQueue.length - apiHead, dbQueue: dbQueue.length - dbHead, dbActive,
    avgLatencyMs: latencies.length ? latencies.reduce((sum, n) => sum + n, 0) / latencies.length : null,
    p95LatencyMs: latencies.length ? latencies[Math.ceil(latencies.length * 0.95) - 1] : null,
  };
  return { schemaVersion: 1, scenarioId: spec.scenarioId, seed: spec.seed, atMs: untilMs, finished: untilMs === DURATION_MS, controls, metrics, series, events,
    requests: requests.map(({ id, arrivedAtMs, status, attempts, latencyMs }) => ({ id, arrivedAtMs, status, attempts, latencyMs })) };
}
export function compareRuns(left: RunSpec, right: RunSpec, untilMs: number): ComparisonView {
  validateRunSpec(left, untilMs); validateRunSpec(right, untilMs);
  if (left.scenarioId !== right.scenarioId || left.seed !== right.seed) throw new SimulationInputError("Comparison requires identical scenario and seed.");
  const a = simulateRun(left, untilMs); const b = simulateRun(right, untilMs);
  return { untilMs, left: a, right: b, delta: { succeeded: b.metrics.succeeded - a.metrics.succeeded, failed: b.metrics.failed - a.metrics.failed, totalAttempts: b.metrics.totalAttempts - a.metrics.totalAttempts } };
}
