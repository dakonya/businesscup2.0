# Versions, verification, and deployment

## Verified versions

Resolved from the npm registry and installed on 2026-11-14:

| Component | Exact version |
| --- | --- |
| Local Node.js | 24.22.3 |
| Local npm | 12.2.2 |
| Next.js | 16.4.6 |
| React / React DOM | 19.3.1 |
| TypeScript | 7.0.2 |
| Zod | 4.6.7 |
| lucide-react | 1.73.0 |
| Vitest | 5.1.0 |
| @types/node | 24.19.2 |
| @types/react / @types/react-dom | 19.3.0 |

The package manifest pins direct dependencies and `package-lock.json` pins the installed tree. Use `npm ci`. Node 24 is declared in `engines` and `.nvmrc`. No provider SDK is installed: native server `fetch` is sufficient.

Version-matched references read: `node_modules/next/AGENTS.md`, `node_modules/next/dist/docs/01-app/01-getting-started/01-installation.md`, layouts/pages, route handlers, and environment-variable guides. No second app, database, Redis, Docker cluster, websocket server, ML training service, or autonomous agent is required.

## Local validation

```bash
npm ci
npm run typecheck
npm test
npm run build
npm start
```

`npm run demo` reproduces the measured branch comparison. The test suites cover deterministic replay, traffic independence, checkpoint boundaries, customer/attempt accounting, late database completions, meaningful intervention outcomes, validation, and actual browser bundling without Node environment globals. API suites exercise real handler logic with controlled provider responses, including fallback/error paths. A mock-provider test proves behavior under that response; it does not prove live NVIDIA inference.

Real provider smoke:

```bash
npm run smoke:coach
```

This makes a small real POST only when both required variables exist. On 2026-11-14, inference was blocked by missing `NVIDIA_API_KEY` and `NVIDIA_MODEL`. No GET /models result or mock response is presented as successful hosted inference. The rest of the trainer backend remains usable through honest rules fallback.

## Obtain a public production URL

The app is suitable for stateless Next.js hosting. It cannot be deployed as static-only export because `/api/coach` and `/api/health` need a Node server. `npm run build` followed by `npm start` is also supported for a Node host; see the [official Next.js self-hosting guide](https://nextjs.org/docs/app/guides/self-hosting).

For an existing Vercel account/project:

1. Integrate the completed backend with the frontend branch, preserving both owners' files; run the checks above. The current homepage is only a scaffold.
2. Import this public GitHub repository as a Next.js project, root directory `.`, Node 24, install `npm ci`, build `npm run build`.
3. Add the three NVIDIA variables to the intended server environment. Never expose them through public variables or commit a secret file. Redeploy after configuration changes.
4. Choose the integrated branch for production and deploy. A branch preview is a separate environment; review [Vercel deployment environments](https://vercel.com/docs/deployments/environments).
5. Make the jury-facing URL publicly accessible without Vercel authentication/password restrictions. Review the project's [Deployment Protection settings](https://vercel.com/docs/deployment-protection); do not assume a preview URL is public.
6. In a signed-out/private browser, open the production homepage, GET `/api/health`, complete a replay/branch/compare through the integrated UI, and request a coach. Verify source/warning honestly. Confirm the same URL works without project membership or login.

No hosting project, paid resource, or production deployment was created by this backend task. No production URL is claimed. The source branch and deployment instructions are ready for integration. Missing AI configuration and the frontend/deployment handoff remain explicit boundaries.

## Final observed checks (2026-11-14)

A fresh `npm ci --no-fund --no-audit`, typecheck, **88 tests in 3 files**, and production build passed. After restarting the built server, HTTP smoke returned `/` 200, `/api/health` 200 with `coachConfigured: false`, and `/api/coach` 200 with `source: rules`, three observations, and verified real event references. Invalid JSON returned 400; an oversized actual body returned 413. The visual browser check could not run because the browser access host was unavailable. This is not presented as a completed interactive frontend end-to-end check. The Russian delivery report is [report-ru.md](report-ru.md).
