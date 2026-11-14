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

Real application-coach smoke:

```bash
npm run smoke
```

This exercises the real `/api/coach` route for seed 42 and the full 120,000 ms A/B demo, and requires `source: "nvidia"`, valid response content, and event references in the correct branch. HTTP 200 with `source: "rules"` fails inference confirmation. `INCIDENTLAB_SMOKE_URL` can target an already-running local or published origin; local `.env` does not configure a remote server.

During the continuation on 2026-11-14 (Asia/Almaty), both required NVIDIA variables were present. A real hosted POST returned **HTTP 401, `Invalid JWT serialization`**. This confirms an authorization failure before model inference; it does not establish a model-access, timeout, output-truncation, or response-validation problem. No successful NVIDIA answer is claimed. The exact current smoke/check results are recorded in [the delivery report](report-ru.md). No GET /models result or mock response substitutes for successful hosted inference. The honest rules fallback remains available.

## Obtain a public production URL

The app is suitable for stateless Next.js hosting. It cannot be deployed as static-only export because `/api/coach` and `/api/health` need a Node server. `npm run build` followed by `npm start` is also supported for a Node host; see the [official Next.js self-hosting guide](https://nextjs.org/docs/app/guides/self-hosting).

## Prepared Vercel configuration

The root `vercel.json` declares the Next.js preset, `npm ci`, and `npm run build`, using the [documented static configuration](https://vercel.com/docs/project-configuration/vercel-json) and current [official schema](https://openapi.vercel.sh/vercel.json). It adds no routing changes, paid resources, or dependencies. The Node 24 range remains in `package.json`; Vercel supports [Node major-version selection through engines](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions). The existing API route owns its 25-second duration limit, so no duplicate function glob is added.

The root `.vercelignore` explicitly excludes local `.env` files, build/cache artifacts, Git internals, and the preserved nested local clone from direct source uploads. The nonsecret `.env.example` remains allowed. This is an upload exclusion, not remote environment provisioning; see [Vercel's ignore-file documentation](https://vercel.com/docs/deployments/vercel-ignore).

## Hosting discovery and authorized creation attempt

The connected Vercel account is authenticated. Read-only project discovery returned **zero projects** both in personal scope and in the sole accessible team `dakonya1` (`team_RIYB4bkSQ0H8Kly7e4EIGKZn`). There is no local `.vercel/project.json`, CLI authorization, or configured Vercel project identifier.

The user subsequently authorized a new project named `incidentlab` for `dakonya/businesscup2.0`, without paid options. The actual create-project call targeted that team with the Next.js preset, ordinary install/build commands, fixed basic resources, elastic concurrency disabled, and public application access. Vercel rejected creation with **HTTP 403 `forbidden`: "You don't have permission to create the project."** No project ID, deployment, environment variable, or production URL was created. Repeating the same request or assuming that another login would fix it is not a verified remedy.

The missing hosting step is an account/team permission that permits **`POST /v11/projects`** in the intended team, or creation/linking of the authorized project by a team member with that permission. User approval already exists; the failure is the connected account's capability. Once the project exists and is accessible, verify its actual ID and Git association before deploying.

The frontend branch is not yet available for integration. Do not publish the scaffold homepage as a completed trainer. Wait for the real frontend handoff, perform an ordinary merge, and validate the combined commit before release.

## Safe server environment transfer and release

When the authorized target is available, configure `NVIDIA_API_KEY`, `NVIDIA_MODEL`, and `NVIDIA_BASE_URL` in that project's **server** Production environment, and Preview only when needed. The local `.env` alone has no effect on a published deployment. Use a sensitive/secret type for the API key. Never use `NEXT_PUBLIC_`, embed values in `vercel.json`, or commit a secret-bearing file.

The connector's environment-update schema accepts literal values; it exposes no local-file reference/import option. Avoid copying secret values into visible tool arguments. A safe automated path is an authenticated local CLI/API helper that loads the existing server environment in-process and sends values via stdin or an HTTPS request body, while logging only variable names and success/failure. Verify the chosen CLI command's current help first. Do not echo values, place them in shell arguments/history, or retrieve hidden connector credentials. Local CLI authorization was absent at discovery, so this path has not yet been executed. A project member may also configure server variables directly in the hosting dashboard without sending them through chat.

After frontend integration, credential repair, and hosting access are resolved:

1. Run typecheck, tests, production build, and the complete browser path on the combined commit. Keep `RunSpec` and cursor as saved state; do not persist full traces.
2. Verify the target project/team/commit and deploy the integrated branch to Production. A preview is a separate environment; see [Vercel deployment environments](https://vercel.com/docs/deployments/environments).
3. Check the jury-facing origin without an authenticated session or bypass token. Confirm application and API access without login or deployment protection; see [Deployment Protection settings](https://vercel.com/docs/deployment-protection).
4. Run `INCIDENTLAB_SMOKE_URL=https://<actual-production-origin> npm run smoke` once. Require `source: "nvidia"`, valid content, correct evidence namespaces, and a factual reading of the actual demo metrics. Do not invent an origin before a deployment exists.
5. Complete start → trace → A → rewind → B → compare → debrief, including reload, saved attempts, and two independent tabs. Record visual verification separately from HTTP smoke.

No paid service, new account, production deployment, or secret upload has occurred in this continuation.

## Earlier baseline (before continuation)

The earlier backend delivery passed `npm ci`, typecheck, **88 tests in 3 files**, production build, and HTTP smoke. Its then-missing NVIDIA configuration yielded `coachConfigured: false` and a valid `source: rules` response. Invalid JSON returned 400 and an oversized body 413. Those historical results are not a claim about successful current NVIDIA inference or a completed integrated frontend. The current continuation's observed results belong in [report-ru.md](report-ru.md).
