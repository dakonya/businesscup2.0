# IncidentLab

Browser-based on-call practice for individual developers preparing for their first rotation. Track: **Skills**. Scenario: **Catalog slowdown**. Logo: **IL**.

## Bootstrap

Use Node.js 24 LTS and npm. Run `npm ci`, then `npm run dev`. Open http://localhost:3000. Checks: `npm run typecheck`, `npm test`, `npm run build`; production: `npm start`.

Shared types: `src/lib/contracts.ts`. Frontend imports `getScenarios`, `simulateRun`, `compareRuns` from `@/lib/sim`. Bootstrap engine functions explicitly throw `EngineNotReadyError` until the engine implementation lands.

Keep server configuration in the ignored `.env` (copy `.env.example` for a new clone). Required for NVIDIA coach: `NVIDIA_API_KEY`, `NVIDIA_MODEL`; default `NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1`. Never expose credentials through `NEXT_PUBLIC_` or the client. Simulation will run without AI configuration.

## Contest context

Three-person team, 24-hour window; web-only B2C; public GitHub and production URL accessible without mandatory login; PDF up to 10 pages; 5-minute pitch + 2-minute Q&A. Scoring: product/engineering 40%, paid value/retention 20%, user/problem 15%, business 15%, originality 10%.

Backend owns dependencies, contracts, simulation, server routes, engineering documentation, and relevant tests. Frontend owns pages, layouts, styles, components, browser state, public assets, UI tests, and demo docs after this bootstrap. Do not create a nested project or overwrite another contributor's changes.
