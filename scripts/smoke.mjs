// One real coach request, through the application's HTTP route and its full validation.
// Optional INCIDENTLAB_SMOKE_URL targets an already-running local or published app.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { access, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import nextEnv from "@next/env";
import { compareRuns } from "../src/lib/sim/index.ts";
import { coachContentSchema } from "../src/lib/server/validation.ts";

nextEnv.loadEnvConfig(process.cwd(), false, { info() {}, error() {} });
const privateValues = [process.env.NVIDIA_API_KEY, process.env.NVIDIA_MODEL, process.env.NVIDIA_BASE_URL].filter(value => value?.trim());
const redact = text => privateValues.reduce((out, value) => out.split(value).join("[redacted]"), String(text));
const primary = { schemaVersion: 1, scenarioId: "catalog-slowdown", seed: 42, actions: [{ atMs: 20_000, type: "set-api-replicas", value: 4 }] };
const comparison = { ...primary, actions: [{ atMs: 20_000, type: "set-max-attempts", value: 1 }] };
const request = { mode: "debrief", primary, comparison, untilMs: 120_000 };
const runs = compareRuns(primary, comparison, request.untilMs);
let child;
let report;
let target = process.env.INCIDENTLAB_SMOKE_URL;
try {
  if (!target) {
    const missing = ["NVIDIA_API_KEY", "NVIDIA_MODEL"].filter(name => !process.env[name]?.trim());
    if (missing.length) throw new Error(`Missing configuration: ${missing.join(", ")}.`);
    await access(".next/BUILD_ID").catch(() => { throw new Error("Production build is missing. Run npm run build first."); });
    const port = await new Promise((resolve, reject) => {
      const reservation = createServer(); reservation.on("error", reject);
      reservation.listen(0, "127.0.0.1", () => {
        const address = reservation.address();
        reservation.close(error => error ? reject(error) : resolve(address.port));
      });
    });
    target = `http://127.0.0.1:${port}`;
    const require = createRequire(import.meta.url);
    child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], {
      env: { ...process.env, NODE_ENV: "production" }, stdio: ["ignore", "pipe", "pipe"],
    });
    // Startup logs are intentionally not echoed: they are unnecessary for inference proof.
    child.stdout.resume(); child.stderr.resume();
    let started = false;
    for (let poll = 0; poll < 100; poll++) {
      if (child.exitCode !== null) throw new Error("Production server exited before readiness.");
      try { const ready = await fetch(`${target}/api/health`, { signal: AbortSignal.timeout(500) }); if (ready.ok) { started = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!started) throw new Error("Production server did not become ready within the startup limit.");
  }
  const origin = new URL(target);
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/" ||
      (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)))) {
    throw new Error("Smoke URL must be an HTTPS origin or a local HTTP origin.");
  }
  const root = origin.origin;
  const health = await fetch(`${root}/api/health`, { redirect: "error", signal: AbortSignal.timeout(10_000) });
  assert.equal(health.status, 200, "Health must be publicly accessible.");
  assert.equal((await health.json()).coachConfigured, true, "Server NVIDIA configuration is absent.");
  const started = performance.now();
  const response = await fetch(`${root}/api/coach`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(23_000), headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
  const coach = await response.json();
  assert.equal(response.status, 200, `Coach HTTP status was ${response.status}.`);
  assert.equal(coach.source, "nvidia", `Real inference not confirmed: source=${coach.source}; ${redact(coach.warning ?? "no warning")}`);
  const { source, warning, ...content } = coach;
  coachContentSchema.parse(content);
  const selfHostedBrev = content.limitations.includes("Self-hosted NVIDIA model on Brev; this is not the NVIDIA-hosted API.");
  if (process.env.NVIDIA_DEPLOYMENT?.trim() === "brev") assert.ok(selfHostedBrev, "Expected self-hosted Brev provenance is missing.");
  const eventIds = new Set([...runs.left.events.map(event => `primary:${event.id}`), ...runs.right.events.map(event => `comparison:${event.id}`)]);
  const references = content.observations.flatMap(observation => observation.evidenceEventIds);
  assert.ok(references.length > 0 && references.every(id => eventIds.has(id)), "Evidence ID missing or associated with the wrong branch.");
  report = { checkedAt: new Date().toISOString(), target: process.env.INCIDENTLAB_SMOKE_URL ? root : "local-production", source, deployment: selfHostedBrev ? "brev" : "hosted", elapsedMs: Math.round(performance.now() - started),
    schemaValidated: true, evidenceValidated: true, evidenceNamespaces: [...new Set(references.map(id => id.split(":")[0]))],
    seed: 42, untilMs: request.untilMs, primaryMetrics: runs.left.metrics, comparisonMetrics: runs.right.metrics, delta: runs.delta, coach,
  };
  await mkdir(".next", { recursive: true });
  await writeFile(".next/incidentlab-smoke.json", redact(JSON.stringify(report, null, 2)) + "\n", { mode: 0o600 });
  console.log(redact(JSON.stringify(report, null, 2)));
} catch (error) {
  console.error(redact(error instanceof Error ? error.message : "Coach smoke failed."));
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([new Promise(resolve => child.once("exit", resolve)), new Promise(resolve => { const timer = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); resolve(); }, 3_000); timer.unref(); })]);
  }
}
