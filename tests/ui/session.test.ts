import assert from "node:assert/strict";
import { test } from "vitest";
import type { SavedSession } from "../../src/lib/contracts";
import { getScenarios } from "../../src/lib/sim";
import {
  appendIntervention,
  controlsAt,
  createAttempt,
  forkAttempt,
  readSession,
  validateSession,
  writeSession,
} from "../../src/lib/client/session";

const scenario = getScenarios()[0];

function session(): SavedSession {
  return {
    schemaVersion: 1,
    activeAttemptId: "a",
    attempts: [createAttempt(scenario, 42, "a", "Попытка A")],
  };
}

test("a checkpoint fork excludes exact-boundary and future decisions without changing A", () => {
  const source = createAttempt(scenario, 42, "a", "Attempt A");
  source.cursorMs = 80_000;
  source.spec.actions = [
    { atMs: 10_000, type: "set-api-replicas", value: 4 },
    { atMs: 20_000, type: "set-max-attempts", value: 1 },
    { atMs: 70_000, type: "set-retry-backoff", value: 1_000 },
  ];
  const before = JSON.stringify(source);
  const branch = forkAttempt(source, scenario.checkpointMs, "b", "Attempt B");
  assert.equal(branch.cursorMs, 20_000);
  assert.deepEqual(branch.spec.actions, [source.spec.actions[0]]);
  const changed = appendIntervention(branch, { atMs: 20_000, type: "set-max-attempts", value: 2 });
  changed.spec.actions[0].value = 1;
  assert.equal(JSON.stringify(source), before);
  assert.equal(branch.spec.actions.length, 1);
  assert.equal(changed.spec.seed, source.spec.seed);
});

test("repeated decisions are idempotent and a present decision creates one event", () => {
  const source = createAttempt(scenario, 42, "a");
  source.cursorMs = 20_000;
  const action = { atMs: 20_000, type: "set-api-replicas" as const, value: 4 };
  const once = appendIntervention(source, action);
  const twice = appendIntervention(once, action);
  assert.equal(source.spec.actions.length, 0);
  assert.equal(twice.spec.actions.length, 1);
  assert.equal(twice, once);
});

test("editing history requires an explicit fork", () => {
  const source = createAttempt(scenario, 42, "a");
  source.cursorMs = 10_000;
  source.spec.actions = [{ atMs: 20_000, type: "set-api-replicas", value: 4 }];
  assert.throws(() => appendIntervention(source, { atMs: 10_000, type: "set-api-replicas", value: 1 }), /новую попытку/);
  assert.throws(() => forkAttempt(source, 20_000, "b", "Attempt B"), /контрольной точки/);
});

test("saved state restores valid future actions but rejects invalid versions, ranges and ordering", () => {
  const value = session();
  value.attempts[0].spec.actions = [{ atMs: 20_000, type: "set-api-replicas", value: 4 }];
  assert.deepEqual(validateSession(value, [scenario]), value);
  for (const invalid of [
    { ...value, schemaVersion: 2 },
    { ...value, activeAttemptId: "missing" },
    { ...value, attempts: [value.attempts[0], value.attempts[0]] },
    { ...value, attempts: [{ ...value.attempts[0], cursorMs: 120_001 }] },
    { ...value, attempts: [{ ...value.attempts[0], spec: { ...value.attempts[0].spec, seed: -1 } }] },
    { ...value, attempts: [{ ...value.attempts[0], spec: { ...value.attempts[0].spec, actions: [{ atMs: 0, type: "set-api-replicas", value: 999 }] } }] },
    { ...value, attempts: [{ ...value.attempts[0], spec: { ...value.attempts[0].spec, actions: [
      { atMs: 20_000, type: "set-api-replicas", value: 4 },
      { atMs: 10_000, type: "set-max-attempts", value: 1 },
    ] } }] },
  ]) assert.equal(validateSession(invalid, [scenario]), null);
});

test("sessions with different workloads cannot be restored for comparison", () => {
  const value = session();
  value.attempts.push(createAttempt(scenario, 99, "b", "Attempt B"));
  assert.equal(validateSession(value, [scenario]), null);
});

test("corrupt and blocked localStorage do not crash practice", () => {
  assert.equal(readSession({ getItem: () => "{bad" }, [scenario]).session, null);
  assert.match(readSession({ getItem: () => "{bad" }, [scenario]).error ?? "", /Не удалось прочитать/);
  assert.equal(readSession({ getItem: () => null }, [scenario]).error, null);
  assert.match(readSession({ getItem: () => { throw new Error("blocked"); } }, [scenario]).error ?? "", /недоступна/);
  assert.match(writeSession({ setItem: () => { throw new Error("quota"); } }, session()) ?? "", /не удалось сохранить/);
});

test("legacy default labels migrate to Russian without changing custom labels or run specifications", () => {
  const legacy = session();
  legacy.attempts[0].label = "Attempt A";
  legacy.attempts.push(createAttempt(scenario, 42, "custom", "Attempt Z — my hypothesis"));
  const restored = validateSession(legacy, [scenario]);
  assert.ok(restored);
  assert.equal(restored.attempts[0].label, "Попытка A");
  assert.equal(restored.attempts[1].label, "Attempt Z — my hypothesis");
  assert.deepEqual(restored.attempts[0].spec, legacy.attempts[0].spec);
  assert.equal(legacy.attempts[0].label, "Attempt A");
  assert.equal(createAttempt(scenario, 42, "default").label, "Попытка A");
});

test("control state is replayed only to the active model time", () => {
  const value = createAttempt(scenario, 42, "a");
  value.cursorMs = 20_000;
  value.spec.actions = [
    { atMs: 20_000, type: "set-max-attempts", value: 1 },
    { atMs: 21_000, type: "set-api-replicas", value: 4 },
  ];
  assert.deepEqual(controlsAt(value, scenario), { ...scenario.defaultControls, maxAttempts: 1 });
});

test("saved inputs share the engine's full uint32 seed range and 64-action limit", () => {
  const value = session();
  value.attempts[0].spec.seed = 4_294_967_295;
  value.attempts[0].spec.actions = Array.from({ length: 64 }, () => ({
    atMs: 20_000, type: "set-api-replicas" as const, value: 4,
  }));
  assert.notEqual(validateSession(value, [scenario]), null);
  value.attempts[0].spec.actions.push({ atMs: 20_000, type: "set-api-replicas", value: 4 });
  assert.equal(validateSession(value, [scenario]), null);
  value.attempts[0].spec.actions = [];
  value.attempts[0].spec.seed = 4_294_967_296;
  assert.equal(validateSession(value, [scenario]), null);
});
