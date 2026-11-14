import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareRuns } from "../../src/lib/sim";

const smokeScript = fileURLToPath(new URL("../../scripts/smoke.mjs", import.meta.url));

const runFile = promisify(execFile);
const content = {
  summary: "Fixture response; no hosted inference is performed by this test.",
  observations: [
    { text: "Inspect the primary branch.", evidenceEventIds: ["primary:invented-event"] },
    { text: "Inspect the comparison branch.", evidenceEventIds: ["comparison:invented-event"] },
  ],
  nextExperiment: "Change one control and replay.",
  limitations: ["Fixture data for a failure-path test."],
};

it.each([
  ["rules response even with HTTP 200", { source: "rules", warning: "Authentication failed: fixture-private-value" }, "Real inference not confirmed", "hosted"],
  ["invalid provider schema", { source: "nvidia", summary: "Missing observations" }, "invalid_type", "hosted"],
  ["invented namespaced evidence", { source: "nvidia", ...content }, "Evidence ID missing", "hosted"],
  ["missing Brev provenance", { source: "nvidia", ...content }, "Expected self-hosted Brev provenance is missing", "brev"],
] as const)("live smoke fails closed for %s without making a provider request", async (_label, reply, expected, deployment) => {
  let coachCalls = 0;
  const server = createServer((request, response) => {
    request.resume();
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/health") response.end(JSON.stringify({ status: "ok", contractVersion: 1, coachConfigured: true }));
    else if (request.url === "/api/coach" && request.method === "POST") { coachCalls++; response.end(JSON.stringify(reply)); }
    else { response.statusCode = 404; response.end("{}"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected local fixture port.");
  const directory = await mkdtemp(join(tmpdir(), "incidentlab-smoke-test-"));
  try {
    const result = await runFile(process.execPath, [smokeScript], {
      cwd: directory, timeout: 5_000, maxBuffer: 128_000,
      env: { ...process.env, INCIDENTLAB_COACH_MODE: "nvidia", INCIDENTLAB_SMOKE_URL: `http://127.0.0.1:${address.port}`, NVIDIA_API_KEY: "fixture-private-value", NVIDIA_MODEL: "fixture-model", NVIDIA_DEPLOYMENT: deployment },
    }).then(value => ({ code: 0, ...value }), error => ({ code: error.code, stdout: error.stdout as string, stderr: error.stderr as string }));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(expected);
    expect(result.stdout + result.stderr).not.toContain("fixture-private-value");
    expect(coachCalls).toBe(1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});


it.each(["hosted", "brev"] as const)("validates a complete %s fixture and writes only an isolated redacted report (not live inference)", async deployment => {
  const primary = { schemaVersion: 1 as const, scenarioId: "catalog-slowdown" as const, seed: 42, actions: [{ atMs: 20_000, type: "set-api-replicas" as const, value: 4 }] };
  const comparison = { ...primary, actions: [{ atMs: 20_000, type: "set-max-attempts" as const, value: 1 }] };
  const runs = compareRuns(primary, comparison, 120_000);
  const reply = { source: "nvidia", ...content, ...(deployment === "brev" ? { limitations: ["Модель NVIDIA работает на Brev. Это отдельный сервер, а не hosted API NVIDIA.", ...content.limitations] } : {}), observations: [
    { text: "Fixture primary event.", evidenceEventIds: [`primary:${runs.left.events[0].id}`] },
    { text: "Fixture comparison event.", evidenceEventIds: [`comparison:${runs.right.events[0].id}`] },
  ] };
  let coachCalls = 0;
  const server = createServer((request, response) => {
    request.resume(); response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/health") response.end(JSON.stringify({ status: "ok", contractVersion: 1, coachConfigured: true }));
    else { coachCalls++; response.end(JSON.stringify(reply)); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected local fixture port.");
  const directory = await mkdtemp(join(tmpdir(), "incidentlab-smoke-fixture-"));
  try {
    await runFile(process.execPath, [smokeScript], {
      cwd: directory, timeout: 5_000, maxBuffer: 128_000,
      env: { ...process.env, INCIDENTLAB_COACH_MODE: "nvidia", INCIDENTLAB_SMOKE_URL: `http://127.0.0.1:${address.port}`, NVIDIA_API_KEY: "fixture-private-value", NVIDIA_MODEL: "fixture-model", NVIDIA_DEPLOYMENT: deployment },
    });
    const path = join(directory, ".next", "incidentlab-smoke.json");
    const text = await readFile(path, "utf8"); const report = JSON.parse(text);
    expect(report).toMatchObject({ deployment, schemaValidated: true, evidenceValidated: true, evidenceNamespaces: ["primary", "comparison"], seed: 42, untilMs: 120_000, primaryMetrics: runs.left.metrics, comparisonMetrics: runs.right.metrics });
    expect(text).not.toContain("fixture-private-value");
    // Windows does not expose the POSIX permission bits used by mode: 0600.
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(coachCalls).toBe(1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
