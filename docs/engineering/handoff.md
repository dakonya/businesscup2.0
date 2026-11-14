# Frontend and product handoff

The shared type authority is `src/lib/contracts.ts`. The public simulation implementation lives in `src/lib/sim/index.ts`. It is synchronous, pure TypeScript and is usable from browser code and server replay. Importing the engine does not require server configuration or NVIDIA access.

The bootstrap is available on branch `setup/incidentlab`, commit `78c615b41ac57698beb0426bd36f6594b1a5ba2f`. Continued backend implementation is on `feat/engine-coach`; use the completed backend branch for the real engine. The bootstrap's temporary engine intentionally threw `EngineNotReadyError`. This handoff does not claim that the full interactive frontend or a public production deployment has been completed.

After bootstrap, pages, layouts, global styles, components, `src/lib/client`, public assets, UI tests, and demo documentation remain frontend-owned. The backend handoff does not rewrite those files. Dependencies and lockfile remain backend-owned; coordinate additions instead of independently reinstalling packages or creating a nested app.

## Run and verify

Use Node.js 24 LTS and npm:

```bash
npm ci
npm run dev
```

Open `http://localhost:3000`. The scaffold page is only a build/integration starting point.

```bash
npm run typecheck
npm test
npm run build
npm start
npm run demo
```

`npm run demo` calls the actual engine using seed 42 and prints the two branch outcomes, deltas, local replay time, trace lengths, and serialized view lengths. It does not call the AI provider. On this development machine, the locally installed runtime can be selected with:

```bash
export PATH=/home/dakonya/.local/share/incidentlab-node/bin:$PATH
```

That path is machine-specific; it is not required by the repository on a machine that already has Node 24 on PATH.

## Use the engine

```ts
import type { RunSpec } from "@/lib/contracts";
import {
  compareRuns,
  forkRun,
  getScenarios,
  simulateRun,
  SimulationInputError,
  validateRunSpec,
} from "@/lib/sim";

const scenario = getScenarios()[0];
const original: RunSpec = {
  schemaVersion: 1,
  scenarioId: scenario.id,
  seed: 42,
  actions: [],
};

const checkpoint = simulateRun(original, scenario.checkpointMs);
// Preserve A's entire action history separately when creating B.
const branchB = forkRun(original, scenario.checkpointMs);
const attemptsControl = scenario.controls.find(
  control => control.type === "set-max-attempts",
)!;
branchB.actions.push({
  atMs: scenario.checkpointMs,
  type: "set-max-attempts",
  value: attemptsControl.values[0],
});
const branchView = simulateRun(branchB, scenario.durationMs);
const comparison = compareRuns(original, branchB, scenario.durationMs);
```

Read title, briefing, duration, checkpoint, default controls, descriptions, and allowed values from `ScenarioDefinition`. The briefing deliberately leaves the mechanism undisclosed. Render controls from its descriptors; do not duplicate ranges or timing constants in the UI. The engine accepts seed integers from 0 through 4,294,967,295 and at most 64 ordered actions per run. Catch `SimulationInputError` at input boundaries and show its controlled message.

Pause means holding the cursor unchanged. Rewind means replaying the saved `RunSpec` at the chosen model time. A new B must retain only actions strictly before the checkpoint, preserve the seed, and permit a new action exactly at that checkpoint. Never delete future actions from saved A when changing the active B. Both sides of a comparison must use the same horizon; delta is right minus left.

`RunView.finished` marks the end of the scenario clock. It does not imply zero pending customers. Customer summaries have one terminal success/failure state or remain pending; total attempts and retries describe database submissions, not customers. Show success, failure, and pending together. Show successful-only latency with its scope, and display a meaningful empty value for `null`.

Use `series` directly for graphs. Use `events` to investigate causality and `requestId` / `attemptId` to filter a complete request trace. Full histories are returned; render a filtered window or page of events. A full demo branch can exceed 2.5 million serialized characters, even though its timeline has only 241 chart samples. Avoid repeatedly serializing or rendering the entire trace on cursor animation frames. See [the model documentation](./model.md) for the measured replay and trace sizes.

## Browser persistence

`RunSpec` and `SavedSession` use `schemaVersion: 1`. Their TypeScript declarations are not a runtime decoder for untrusted localStorage. Frontend integration must implement guarded JSON parsing and session-level validation before replacing active state:

- Check the session version, a bounded attempts array, unique attempt IDs, string labels, and an `activeAttemptId` that refers to an existing attempt.
- Validate each specification with `validateRunSpec`, and each integer cursor against its scenario duration.
- Preserve saved A and create an independent B using `forkRun`.
- For corrupted, unsupported, or old saves, show a clear explanation and a “Start new session” action. Do not crash or silently treat an old save as valid.

These are frontend integration responsibilities; the backend handoff does not claim a browser persistence UI has been implemented.

## Coach integration

Send a `CoachRequest` containing the run specifications and horizon. The server recomputes metrics; the browser does not supply trusted numbers or provider URLs.

```ts
import type { CoachRequest, CoachResponse } from "@/lib/contracts";

const body: CoachRequest = {
  mode: "debrief",
  primary: original,
  comparison: branchB,
  untilMs: scenario.durationMs,
};
const response = await fetch("/api/coach", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(22_000),
});
if (!response.ok) throw new Error("Coach request could not be completed.");
const coach: CoachResponse = await response.json();
```

Show `source` and any `warning` honestly: `rules` is a deterministic fallback, while `nvidia` means a validated real provider response. Failure or missing AI configuration must not block replay and comparison. Hints use `mode: "hint"` and optional `hintLevel: 1 | 2 | 3`; debrief may reveal the mechanism.

Evidence IDs are namespaced `primary:<eventId>` or `comparison:<eventId>`. Resolve the prefix to the correct branch before opening its trace event; IDs from different branches can otherwise coincide. Keep an active request generation token or abort the prior request so a late response cannot overwrite a later attempt's coach panel. Offer retry after an honest failure; do not automatically loop provider requests. Detailed HTTP limits and provider behavior are documented separately by the backend owner.

## Product claims supported by this handoff

The current backend supports a reproducible individual incident experiment: identical seeded traffic, inspectable request/attempt traces, policy interventions, checkpoint branching, same-horizon comparison, and a coach that cannot alter simulation state. It does not demonstrate a broad curriculum, multiplayer collaboration, real cloud infrastructure, or proof of job readiness.

For the reproducible seed-42 example at 120 seconds:

| Outcome | A: 4 API replicas at 20 s | B: 1 maximum attempt at 20 s |
| --- | ---: | ---: |
| Succeeded customers | 120 | 709 |
| Failed customers | 800 | 248 |
| Pending customers | 40 | 3 |
| Database attempts | 2,588 | 987 |

Both branches receive 960 customers. B produces 589 more successful responses and 552 fewer failures than A in this defined case. Describe these as simulated outcomes; do not present them as real-world performance improvements, universal tuning advice, or a readiness percentage. B's remaining 248 failures and 3 pending customers are part of the result.

The supplied contest brief calls for a three-person team, a 24-hour build, a web-only B2C product, a public GitHub repository and production URL without mandatory login, a PDF of up to ten pages, and a five-minute pitch plus two-minute Q&A. Weights supplied in the brief are product/engineering 40%, paid value/retention 20%, user/problem 15%, business 15%, and originality 10%. This backend handoff preserves that context; it does not verify official contest rules, create the pitch/PDF, or establish paid retention and business demand.

## Integration continuation — 2026-11-14

The remote audit found only `feat/engine-coach`, `setup/incidentlab`, and `main`; the user confirmed that frontend is not ready. No candidate was guessed, no merge performed, and no competing UI created. Publish the actual frontend branch and handoff before integration. Contract v1 and frontend-owned source files remain unchanged.

The backend now supplies `npm run smoke`: after a build it launches a temporary production server and requires a real `source: nvidia` coach response for the exact seed-42 A/B demo, shared schema, and valid branch-specific citations. `INCIDENTLAB_SMOKE_URL` targets the eventual published origin. The latest real hosted call failed authentication with HTTP 401; configuration presence must not be displayed as proven inference health. Rules fallback remains available and now distinguishes authentication/access failures.

After the ordinary merge, explicitly verify start → trace → intervention A → rewind → B → compare → debrief, new session/reload/saved attempts, and independent tabs. Check that full trace is absent from localStorage and replay is not called on every animation frame. Show success, failed, and pending separately, and label p95 as successful responses only. No integrated browser-flow claim has been made while the frontend is absent.
