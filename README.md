# IncidentLab

Browser-based on-call practice for individual developers preparing for a first rotation. Track: **Skills**. First scenario: **Catalog slowdown**. Logo: **IL**.

## Install and run

Use **Node.js 24 LTS** and npm:

```bash
npm ci
cp .env.example .env  # new clones only; preserve an existing .env
npm run dev
```

Open http://localhost:3000. The current homepage is the frontend handoff scaffold. The backend engine and API are implemented; the full interactive training UI belongs to the frontend integration.

```bash
npm run typecheck
npm test
npm run build
npm start
npm run demo
npm run smoke:coach
```

`demo` runs the actual deterministic engine with seed 42 and prints two branch outcomes, deltas, trace sizes, and measured replay time. `smoke:coach` performs one small real NVIDIA inference when configured; missing configuration exits with code 2 and variable names only. `health` reports configuration presence, not proven provider health.

On the current development machine, Node/npm were installed outside the repository. If they are absent from PATH:

```bash
export PATH=/home/dakonya/.local/share/incidentlab-node/bin:$PATH
```

## Server configuration

| Variable | Purpose |
| --- | --- |
| `NVIDIA_API_KEY` | Server-side NVIDIA credential |
| `NVIDIA_BASE_URL` | Default: `https://integrate.api.nvidia.com/v1` |
| `NVIDIA_MODEL` | Explicit hosted model ID; no implicit paid-provider/model selection |

Keep credentials in ignored `.env` files or the hosting platform's server environment. Never use a `NEXT_PUBLIC_` credential. No database or additional service is required. Missing configuration, timeout, rate limiting, or invalid provider output produces a clearly labeled `source: "rules"` analysis. The engine does not require AI.

## Architecture and handoff

- `src/lib/contracts.ts`: authoritative contract v1, unchanged from the supplied handoff.
- `src/lib/sim`: pure, synchronous TypeScript replay shared by browser and server; exports `getScenarios`, `simulateRun`, `compareRuns`, plus validation/fork helpers.
- `src/lib/server` and `src/app/api`: stateless health/coach handlers. Coach validates the journal, recomputes results, selects bounded evidence, and validates provider JSON and namespaced event IDs.
- Browser persistence: scenario + seed + ordered actions + cursor. Frontend owns guarded localStorage decoding and the full user flow.

The model computes admission, database queues, timeouts, uncancelled work, retries, and unique customer outcomes. It is a bounded teaching simulation, not real infrastructure or a readiness assessment. Latency statistics describe successful responses only. Read failed and pending counts alongside them. API scaling may increase database pressure in this case; this is not a universal tuning rule.

[Model and measured demo](docs/engineering/model.md) · [Frontend/product handoff](docs/engineering/handoff.md) · [HTTP and coach limits](docs/engineering/api.md) · [Versions, verification, and deployment](docs/engineering/operations.md)

Bootstrap branch: `setup/incidentlab`, commit `78c615b41ac57698beb0426bd36f6594b1a5ba2f`. Backend implementation: `feat/engine-coach`. Frontend owns pages, layouts, styles, components, browser state, assets, UI tests, and demo docs after bootstrap. Backend owns dependencies, contract, simulation, server routes, engineering docs, and associated tests. Do not create a nested project or overwrite another contributor's work.

## Contest context supplied by the team

Three-person team, 24-hour build; web-only B2C; public GitHub and a production URL accessible without mandatory login; PDF up to 10 pages; 5-minute pitch + 2-minute Q&A. Weights: product/engineering 40%, paid value/retention 20%, user/problem 15%, business 15%, originality 10%. These are supplied requirements, not independently verified official rules.
