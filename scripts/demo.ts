import { performance } from "node:perf_hooks";
import { compareRuns, simulateRun } from "../src/lib/sim/index.ts";
import type { RunSpec } from "../src/lib/contracts.ts";
const base: RunSpec = { schemaVersion: 1, scenarioId: "catalog-slowdown", seed: 42, actions: [] };
const scaleApi: RunSpec = { ...base, actions: [{ atMs: 20_000, type: "set-api-replicas", value: 4 }] };
const limitRetries: RunSpec = { ...base, actions: [{ atMs: 20_000, type: "set-max-attempts", value: 1 }] };
const start = performance.now();
const result = compareRuns(scaleApi, limitRetries, 120_000);
const replayPairMs = performance.now() - start;
console.log(JSON.stringify({ seed: base.seed, horizonMs: result.untilMs, actionsA: scaleApi.actions, actionsB: limitRetries.actions,
  baseline: simulateRun(base, 120_000).metrics, branchA: result.left.metrics, branchB: result.right.metrics, delta: result.delta,
  replayPairMs: +replayPairMs.toFixed(2), traceEvents: [result.left.events.length, result.right.events.length],
  responseBytes: [JSON.stringify(result.left).length, JSON.stringify(result.right).length] }, null, 2));
