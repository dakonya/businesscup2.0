import { describe, expect, it } from "vitest";
import type { Intervention, RunSpec, RunView } from "../../src/lib/contracts";
import { compareRuns, forkRun, getScenarios, simulateRun, SimulationInputError } from "../../src/lib/sim";

const scenario = getScenarios()[0];
const run = (actions: Intervention[] = [], seed = 42): RunSpec => ({
  schemaVersion: 1, scenarioId: scenario.id, seed, actions,
});
const arrivals = (view: RunView) => view.requests.map(({ id, arrivedAtMs }) => ({ id, arrivedAtMs }));

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}

function checkAccounting(view: RunView) {
  const { metrics, requests, events, series } = view;
  const successes = requests.filter(request => request.status === "succeeded");
  expect(metrics.arrived).toBe(requests.length);
  expect(metrics.succeeded).toBe(successes.length);
  expect(metrics.failed).toBe(requests.filter(request => request.status === "failed").length);
  expect(metrics.pending).toBe(requests.filter(request => request.status === "pending").length);
  expect(metrics.arrived).toBe(metrics.succeeded + metrics.failed + metrics.pending);
  expect(metrics.totalAttempts).toBe(requests.reduce((sum, request) => sum + request.attempts, 0));
  expect(metrics.retries).toBe(requests.reduce((sum, request) => sum + Math.max(0, request.attempts - 1), 0));
  expect(metrics.totalAttempts).toBe(events.filter(event => event.kind === "attempt-created").length);
  expect(new Set(requests.map(request => request.id)).size).toBe(requests.length);
  expect(new Set(events.map(event => event.id)).size).toBe(events.length);
  expect(events.every((event, index) => Number.isInteger(event.atMs) && event.atMs <= view.atMs && (!index || event.atMs >= events[index - 1].atMs))).toBe(true);
  expect([metrics.apiQueue, metrics.dbQueue, metrics.dbActive].every(value => Number.isInteger(value) && value >= 0)).toBe(true);
  for (const request of requests) {
    expect(Number.isInteger(request.attempts) && request.attempts >= 0).toBe(true);
    expect(request.arrivedAtMs).toBeLessThanOrEqual(view.atMs);
    if (request.status === "succeeded") {
      const response = events.find(event => event.kind === "request-succeeded" && event.requestId === request.id);
      expect(response).toBeDefined();
      expect(request.latencyMs).toBe(response!.atMs - request.arrivedAtMs);
      expect(events.some(event => event.kind === "request-failed" && event.requestId === request.id)).toBe(false);
    } else expect(request.latencyMs).toBeNull();
  }
  const latencies = successes.map(request => request.latencyMs!).sort((a, b) => a - b);
  expect(metrics.avgLatencyMs).toBe(latencies.length ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : null);
  expect(metrics.p95LatencyMs).toBe(latencies.length ? latencies[Math.ceil(latencies.length * 0.95) - 1] : null);
  const finalPoint = series.at(-1)!;
  expect(finalPoint).toMatchObject({
    atMs: view.atMs, succeeded: metrics.succeeded, failed: metrics.failed,
    pending: metrics.pending, totalAttempts: metrics.totalAttempts,
    apiQueue: metrics.apiQueue, dbQueue: metrics.dbQueue,
  });
}

describe("deterministic simulation and recovery", () => {
  it("replays frozen inputs identically without mutating either actions or controls", () => {
    const spec = freezeDeep(run([
      { atMs: scenario.checkpointMs, type: "set-max-attempts", value: 1 },
      { atMs: scenario.checkpointMs + 500, type: "set-retry-backoff", value: 1_000 },
    ]));
    const before = JSON.stringify(spec);
    expect(simulateRun(spec, scenario.durationMs)).toEqual(simulateRun(spec, scenario.durationMs));
    expect(JSON.stringify(spec)).toBe(before);
  });

  it("returns independent scenario metadata and run views", () => {
    const original = getScenarios();
    const changed = getScenarios();
    changed[0].defaultControls.apiReplicas = 123;
    changed[0].controls[0].values.length = 0;
    changed[0].learningGoals.push("corrupted");
    expect(getScenarios()).toEqual(original);
    const first = simulateRun(run(), 1_000);
    const before = structuredClone(first);
    simulateRun(run([{ atMs: 0, type: "set-api-replicas", value: 8 }]), scenario.durationMs);
    expect(first).toEqual(before);
  });

  it("keeps the external traffic identical when every control changes", () => {
    const baseline = simulateRun(run(), scenario.durationMs);
    const changed = simulateRun(run([
      { atMs: 0, type: "set-api-replicas", value: 8 },
      { atMs: 10_000, type: "set-max-attempts", value: 1 },
      { atMs: scenario.checkpointMs, type: "set-retry-backoff", value: 2_000 },
    ]), scenario.durationMs);
    expect(arrivals(changed)).toEqual(arrivals(baseline));
    expect(arrivals(simulateRun(run([], 43), scenario.durationMs))).not.toEqual(arrivals(baseline));
  });

  it("forks strictly before the checkpoint and keeps A unchanged", () => {
    const earlier: Intervention = { atMs: 5_000, type: "set-retry-backoff", value: 250 };
    const a = freezeDeep(run([
      earlier,
      { atMs: scenario.checkpointMs, type: "set-api-replicas", value: 4 },
      { atMs: scenario.checkpointMs + 1_000, type: "set-max-attempts", value: 2 },
    ]));
    const savedA = simulateRun(a, scenario.durationMs);
    const b = forkRun(a, scenario.checkpointMs);
    expect(b).toEqual(run([earlier]));
    expect(b.actions[0]).not.toBe(a.actions[0]);
    expect(simulateRun(b, scenario.checkpointMs)).toEqual(simulateRun(run([earlier]), scenario.checkpointMs));
    b.actions.push({ atMs: scenario.checkpointMs, type: "set-max-attempts", value: 1 });
    simulateRun(b, scenario.durationMs);
    expect(simulateRun(a, scenario.durationMs)).toEqual(savedA);
    expect(a.actions).toHaveLength(3);
  });

  it("does not execute future actions while preserving replay prefixes and trace IDs", () => {
    const actions: Intervention[] = [{ atMs: 30_000, type: "set-api-replicas", value: 4 }];
    const prefix = simulateRun(run(actions), 20_000);
    expect(prefix).toEqual(simulateRun(run(), 20_000));
    const complete = simulateRun(run(actions), scenario.durationMs);
    expect(complete.events.filter(event => event.atMs <= 20_000)).toEqual(prefix.events);
    expect(complete.series.filter(point => point.atMs <= 20_000)).toEqual(prefix.series);
  });
});

describe("customer outcomes and real queue dynamics", () => {
  it.each([0, 42, 4_294_967_295])("maintains request and attempt accounting for seed %s at multiple horizons", seed => {
    for (const horizon of [0, 500, 14_999, scenario.checkpointMs, 23_000, 40_000, scenario.durationMs]) {
      checkAccounting(simulateRun(run([], seed), horizon));
    }
  });

  it("handles healthy traffic before the incident, then computes retries and timeouts", () => {
    const healthy = simulateRun(run(), 14_999);
    expect(healthy.metrics.arrived).toBeGreaterThan(0);
    expect(healthy.metrics.succeeded).toBeGreaterThan(0);
    expect(healthy.metrics.failed).toBe(0);
    expect(healthy.metrics.retries).toBe(0);
    const incident = simulateRun(run(), 30_000);
    expect(incident.events.some(event => event.kind === "attempt-timeout")).toBe(true);
    expect(incident.metrics.retries).toBeGreaterThan(0);
    expect(incident.metrics.dbQueue).toBeGreaterThan(0);
  });

  it("discards late database work without retroactively succeeding a failed customer", () => {
    const complete = simulateRun(run(), scenario.durationMs);
    const late = complete.events.filter(event => event.kind === "late-response");
    expect(late.length).toBeGreaterThan(0);
    for (const response of late) {
      const timeout = complete.events.find(event => event.kind === "attempt-timeout" && event.attemptId === response.attemptId);
      expect(timeout).toBeDefined();
      expect(timeout!.atMs).toBeLessThanOrEqual(response.atMs);
      expect(complete.events.some(event => event.kind === "request-succeeded" && event.attemptId === response.attemptId)).toBe(false);
    }
    const failedBeforeLateWork = late.find(response => complete.events.some(event => event.kind === "request-failed" && event.requestId === response.requestId && event.atMs < response.atMs));
    expect(failedBeforeLateWork).toBeDefined();
    const requestId = failedBeforeLateWork!.requestId;
    const failedAtMs = complete.events.find(event => event.kind === "request-failed" && event.requestId === requestId)!.atMs;
    expect(simulateRun(run(), failedAtMs).requests.find(request => request.id === requestId)!.status).toBe("failed");
    expect(complete.requests.find(request => request.id === requestId)!.status).toBe("failed");
  });

  it("computes a useful retry-limiting experiment against scaling API under identical traffic", () => {
    const a = run([{ atMs: scenario.checkpointMs, type: "set-api-replicas", value: 4 }]);
    const b = run([{ atMs: scenario.checkpointMs, type: "set-max-attempts", value: 1 }]);
    const comparison = compareRuns(a, b, scenario.durationMs);
    expect(arrivals(comparison.right)).toEqual(arrivals(comparison.left));
    expect(comparison.right.metrics.succeeded).toBeGreaterThan(comparison.left.metrics.succeeded);
    expect(comparison.right.metrics.failed).toBeLessThan(comparison.left.metrics.failed);
    expect(comparison.right.metrics.totalAttempts).toBeLessThan(comparison.left.metrics.totalAttempts);
    expect(comparison.delta).toEqual({
      succeeded: comparison.right.metrics.succeeded - comparison.left.metrics.succeeded,
      failed: comparison.right.metrics.failed - comparison.left.metrics.failed,
      totalAttempts: comparison.right.metrics.totalAttempts - comparison.left.metrics.totalAttempts,
    });
    const recovered = comparison.right.series.find(point => point.atMs >= 60_000 && point.dbQueue === 0);
    expect(recovered).toBeDefined();
    checkAccounting(comparison.left);
    checkAccounting(comparison.right);
  });
});

describe("event boundaries and public input validation", () => {
  it.each([0, 499, 500, 501, scenario.durationMs])("samples horizon %s exactly once", horizon => {
    const view = simulateRun(run(), horizon);
    expect(view.series[0].atMs).toBe(0);
    expect(view.series.at(-1)!.atMs).toBe(horizon);
    expect(view.series.filter(point => point.atMs === horizon)).toHaveLength(1);
    expect(view.series.slice(0, -1).every(point => point.atMs % 500 === 0)).toBe(true);
    expect(view.finished).toBe(horizon === scenario.durationMs);
  });

  it("includes arrival-boundary events and applies interventions before that arrival", () => {
    const first = simulateRun(run(), 500).requests[0];
    expect(simulateRun(run(), first.arrivedAtMs - 1).requests).toHaveLength(0);
    const view = simulateRun(run([{ atMs: first.arrivedAtMs, type: "set-max-attempts", value: 1 }]), first.arrivedAtMs);
    expect(view.requests).toHaveLength(1);
    expect(view.events.map(event => event.kind)).toEqual(["intervention", "arrival", "attempt-created", "db-start"]);
    expect(view.controls.maxAttempts).toBe(1);
    expect(view.metrics.pending).toBe(1);
    expect(view.metrics.failed).toBe(0);
    expect(view.metrics.avgLatencyMs).toBeNull();
  });

  it("applies same-time controls in array order before admitting queued work", () => {
    const finalOnly = simulateRun(run([{ atMs: scenario.checkpointMs, type: "set-api-replicas", value: 1 }]), 25_000);
    const overwritten = simulateRun(run([
      { atMs: scenario.checkpointMs, type: "set-api-replicas", value: 8 },
      { atMs: scenario.checkpointMs, type: "set-api-replicas", value: 1 },
    ]), 25_000);
    expect(overwritten.controls.apiReplicas).toBe(1);
    expect(overwritten.requests).toEqual(finalOnly.requests);
    expect(overwritten.metrics).toEqual(finalOnly.metrics);
    expect(overwritten.series).toEqual(finalOnly.series);
    expect(overwritten.events.filter(event => event.kind === "intervention").map(event => event.data!.value)).toEqual([8, 1]);
  });

  it("uses the changed attempt budget for a timeout at exactly the intervention time", () => {
    const firstTimeout = simulateRun(run(), 25_000).events.find(event => event.kind === "attempt-timeout")!;
    const changed = simulateRun(run([{ atMs: firstTimeout.atMs, type: "set-max-attempts", value: 1 }]), firstTimeout.atMs);
    expect(changed.requests.find(request => request.id === firstTimeout.requestId)!.status).toBe("failed");
    expect(changed.events.some(event => event.kind === "request-failed" && event.requestId === firstTimeout.requestId && event.atMs === firstTimeout.atMs)).toBe(true);
    expect(changed.events.some(event => event.kind === "retry-scheduled" && event.attemptId === firstTimeout.attemptId)).toBe(false);
    const sameTime = changed.events.filter(event => event.atMs === firstTimeout.atMs);
    expect(sameTime[0].kind).toBe("intervention");
  });

  it("keeps an already scheduled retry's due time when backoff changes later", () => {
    const firstTimeout = simulateRun(run(), 25_000).events.find(event => event.kind === "attempt-timeout")!;
    const actions: Intervention[] = [
      { atMs: firstTimeout.atMs, type: "set-retry-backoff", value: 2_000 },
      { atMs: firstTimeout.atMs + 1, type: "set-retry-backoff", value: 0 },
    ];
    const beforeDue = simulateRun(run(actions), firstTimeout.atMs + 1_999);
    const scheduled = beforeDue.events.find(event => event.kind === "retry-scheduled" && event.attemptId === firstTimeout.attemptId)!;
    expect(scheduled.data!.retryAtMs).toBe(firstTimeout.atMs + 2_000);
    expect(beforeDue.requests.find(request => request.id === firstTimeout.requestId)!.attempts).toBe(1);
    expect(beforeDue.controls.retryBackoffMs).toBe(0);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, scenario.durationMs + 1])("rejects invalid horizon %s", horizon => {
    expect(() => simulateRun(run(), horizon)).toThrow(SimulationInputError);
  });

  it.each([-1, 0.5, Number.NaN, 4_294_967_296])("rejects invalid seed %s", seed => {
    expect(() => simulateRun(run([], seed), 0)).toThrow(SimulationInputError);
  });

  it("rejects bad schema, scenario, intervention, value, count, ordering, and future parameters", () => {
    const invalid: unknown[] = [
      null,
      { ...run(), schemaVersion: 2 },
      { ...run(), scenarioId: "unknown" },
      { ...run(), actions: null },
      run([{ atMs: 1, type: "set-api-replicas", value: 99 }]),
      run([{ atMs: 1, type: "unknown", value: 1 } as unknown as Intervention]),
      run([{ atMs: 1.5, type: "set-max-attempts", value: 1 }]),
      run([{ atMs: -1, type: "set-max-attempts", value: 1 }]),
      run([{ atMs: scenario.durationMs + 1, type: "set-max-attempts", value: 1 }]),
      run([{ atMs: 2, type: "set-max-attempts", value: 1 }, { atMs: 1, type: "set-max-attempts", value: 2 }]),
      run(Array.from({ length: 65 }, () => ({ atMs: 0, type: "set-max-attempts" as const, value: 1 }))),
    ];
    for (const input of invalid) expect(() => simulateRun(input as RunSpec, 0)).toThrow(SimulationInputError);
  });

  it("rejects comparisons of different traffic or unsupported scenarios", () => {
    expect(() => compareRuns(run([], 1), run([], 2), 20_000)).toThrow(SimulationInputError);
    expect(() => compareRuns(run(), { ...run(), scenarioId: "other" } as unknown as RunSpec, 20_000)).toThrow(SimulationInputError);
  });
});
