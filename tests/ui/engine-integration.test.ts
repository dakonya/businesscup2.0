import assert from "node:assert/strict";
import { test } from "vitest";
import type { SavedAttempt, SavedSession } from "../../src/lib/contracts";
import { compareRuns, getScenarios, simulateRun } from "../../src/lib/sim";
import {
  appendIntervention,
  createAttempt,
  forkAttempt,
  readSession,
  validateSession,
  writeSession,
} from "../../src/lib/client/session";

const scenarios = getScenarios();
const scenario = scenarios[0];

function at(attempt: SavedAttempt, cursorMs: number): SavedAttempt {
  return { ...attempt, cursorMs };
}

test("real replay forks strict pre-checkpoint history and preserves all of A", () => {
  let a = createAttempt(scenario, 42, "source-a", "Attempt A");
  a = appendIntervention(at(a, 10_000), { atMs: 10_000, type: "set-retry-backoff", value: 250 });
  a = appendIntervention(at(a, scenario.checkpointMs), {
    atMs: scenario.checkpointMs, type: "set-api-replicas", value: 4,
  });
  a = appendIntervention(at(a, 70_000), { atMs: 70_000, type: "set-api-replicas", value: 8 });
  a = at(a, scenario.durationMs);
  const preservedA = structuredClone(a);
  const fork = forkAttempt(a, scenario.checkpointMs, "branch-b", "Attempt B");
  const b = appendIntervention(fork, {
    atMs: scenario.checkpointMs, type: "set-max-attempts", value: 1,
  });

  assert.deepEqual(a, preservedA);
  assert.deepEqual(fork.spec.actions, [a.spec.actions[0]]);
  assert.equal(b.spec.actions.length, 2);
  assert.notEqual(b.spec.actions[0], a.spec.actions[0]);
  assert.equal(b.spec.seed, a.spec.seed);
  assert.deepEqual(
    simulateRun(a.spec, scenario.checkpointMs - 1),
    simulateRun(b.spec, scenario.checkpointMs - 1),
  );
  const checkpointA = simulateRun(a.spec, scenario.checkpointMs);
  const checkpointB = simulateRun(b.spec, scenario.checkpointMs);
  assert.equal(checkpointA.controls.apiReplicas, 4);
  assert.equal(checkpointB.controls.apiReplicas, scenario.defaultControls.apiReplicas);
  assert.equal(checkpointB.controls.maxAttempts, 1);
  assert.equal(checkpointB.controls.retryBackoffMs, 250);
  assert.deepEqual(a, preservedA);
});

test("seed-42 A/B comparison uses identical traffic and keeps customer accounting intact", () => {
  const a = appendIntervention(at(createAttempt(scenario, 42, "a"), scenario.checkpointMs), {
    atMs: scenario.checkpointMs, type: "set-api-replicas", value: 4,
  });
  const b = appendIntervention(forkAttempt(a, scenario.checkpointMs, "b", "Attempt B"), {
    atMs: scenario.checkpointMs, type: "set-max-attempts", value: 1,
  });
  const comparison = compareRuns(a.spec, b.spec, scenario.durationMs);
  const left = comparison.left.metrics;
  const right = comparison.right.metrics;
  assert.equal(comparison.left.atMs, comparison.right.atMs);
  assert.equal(comparison.untilMs, scenario.durationMs);
  assert.equal(left.arrived, right.arrived);
  assert.equal(left.arrived, 960);
  assert.deepEqual(
    comparison.left.requests.map(({ id, arrivedAtMs }) => ({ id, arrivedAtMs })),
    comparison.right.requests.map(({ id, arrivedAtMs }) => ({ id, arrivedAtMs })),
  );
  for (const metrics of [left, right]) {
    assert.equal(metrics.arrived, metrics.succeeded + metrics.failed + metrics.pending);
    assert.ok(metrics.pending > 0, "finished model time may still contain waiting customers");
    assert.ok(metrics.totalAttempts >= metrics.retries);
  }
  assert.ok(right.succeeded > left.succeeded);
  assert.ok(right.failed < left.failed);
  assert.ok(right.totalAttempts < left.totalAttempts);
  assert.equal(comparison.delta.succeeded, right.succeeded - left.succeeded);
  assert.equal(comparison.delta.failed, right.failed - left.failed);
  assert.equal(comparison.delta.totalAttempts, right.totalAttempts - left.totalAttempts);
});

test("saved specifications retain future decisions and restore the same real replay", () => {
  let a = createAttempt(scenario, 42, "a");
  a = appendIntervention(at(a, scenario.checkpointMs), {
    atMs: scenario.checkpointMs, type: "set-api-replicas", value: 4,
  });
  a = appendIntervention(at(a, 60_000), { atMs: 60_000, type: "set-retry-backoff", value: 1_000 });
  a = at(a, scenario.checkpointMs);
  const session: SavedSession = { schemaVersion: 1, activeAttemptId: a.id, attempts: [a] };
  let serialized: string | null = null;
  const storage = {
    getItem: () => serialized,
    setItem: (_key: string, value: string) => { serialized = value; },
  };
  assert.equal(writeSession(storage, session), null);
  const restored = readSession(storage, scenarios);
  assert.equal(restored.error, null);
  assert.ok(restored.session);
  assert.deepEqual(restored.session, session);
  assert.equal(restored.session.attempts[0].spec.actions.length, 2);
  assert.deepEqual(
    simulateRun(restored.session.attempts[0].spec, scenario.durationMs),
    simulateRun(a.spec, scenario.durationMs),
  );
  const invalid = structuredClone(session);
  invalid.attempts[0].cursorMs = scenario.durationMs + 1;
  assert.equal(validateSession(invalid, scenarios), null);
  invalid.attempts[0].cursorMs = -1;
  assert.equal(validateSession(invalid, scenarios), null);
});

test("the 65th decision is rejected without altering the valid 64-action attempt", () => {
  const base = createAttempt(scenario, 42, "a");
  const values = scenario.controls.find((control) => control.type === "set-api-replicas")!.values;
  base.spec.actions = Array.from({ length: 63 }, (_, i) => ({
    atMs: i, type: "set-api-replicas" as const, value: values[i % values.length],
  }));
  const accepted = appendIntervention(at(base, 63), {
    atMs: 63, type: "set-api-replicas", value: values[63 % values.length],
  });
  assert.equal(accepted.spec.actions.length, 64);
  const before = structuredClone(accepted);
  assert.throws(() => appendIntervention(at(accepted, 64), {
    atMs: 64, type: "set-api-replicas", value: values[64 % values.length],
  }), /64/);
  assert.deepEqual(accepted, before);
  const session: SavedSession = { schemaVersion: 1, activeAttemptId: "a", attempts: [accepted] };
  assert.ok(validateSession(session, scenarios));
  const tooMany = structuredClone(session);
  tooMany.attempts[0].spec.actions.push({ atMs: 64, type: "set-api-replicas", value: values[0] });
  assert.equal(validateSession(tooMany, scenarios), null);
});
