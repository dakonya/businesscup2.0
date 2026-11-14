# HTTP contract and grounded coach

The authority for request and response types is `src/lib/contracts.ts`; this document describes runtime limits. Routes run on Next.js's Node runtime and return `Cache-Control: no-store`.

## GET /api/health

Returns HTTP 200 and `HealthResponse`: `status: "ok"`, `contractVersion: 1`, and `coachConfigured`. The boolean requires explicit `INCIDENTLAB_COACH_MODE=nvidia`, nonblank `NVIDIA_API_KEY` and `NVIDIA_MODEL`, and a recognized deployment setting. Brev also requires its explicit base URL and the supported Nano 9B model ID. It does not validate network access, call the model, or prove inference health. It exposes no secret values.

## POST /api/coach

Demo mode is `INCIDENTLAB_COACH_MODE=rules`, also used when the server parameter is absent. It returns the computed Russian rules recap with `source: "rules"` and a visible warning that NVIDIA requests are disabled, even if NVIDIA credentials already exist. Only the explicit server opt-in `INCIDENTLAB_COACH_MODE=nvidia` reaches hosted/Brev inference. This setting is separate from the request's `mode: "hint" | "debrief"`; clients cannot override the server's demo mode.

Send JSON matching `CoachRequest`:

```json
{
  "mode": "debrief",
  "primary": {
    "schemaVersion": 1,
    "scenarioId": "catalog-slowdown",
    "seed": 42,
    "actions": [{ "atMs": 20000, "type": "set-api-replicas", "value": 4 }]
  },
  "comparison": {
    "schemaVersion": 1,
    "scenarioId": "catalog-slowdown",
    "seed": 42,
    "actions": [{ "atMs": 20000, "type": "set-max-attempts", "value": 1 }]
  },
  "untilMs": 120000
}
```

`hint` accepts optional `hintLevel` 1–3. Level 1 directs investigation without giving the mechanism or winning control; level 2 points to timing/retry evidence; level 3 suggests one control experiment. Debrief can explain the mechanism. Coach never alters a run.

The server rejects unknown properties, including client-supplied metrics/provider URLs. It validates the scenario, integer seed 0–4294967295, at most 64 actions per run, ordered integer timestamps and horizon 0–120000, and values declared by `ScenarioDefinition`. Comparison requires the same scenario and seed. Future actions are validated even if not yet executed.

Body size is limited to **16,384 UTF-8 bytes**, including streamed bodies with absent or misleading Content-Length. The server replays both runs itself, then sends metrics, final controls, and at most 24 selected events per branch. It does not forward the entire trace, browser messages, or secrets to the model. At very early horizons with insufficient events it returns rules analysis and explains the lack of evidence.

| Status | Response |
| --- | --- |
| 200 | `CoachResponse`; `source` is `nvidia` or `rules` |
| 400 | `ApiError`, invalid JSON or input |
| 413 | `ApiError`, body too large |
| 429 | `ApiError`, actual local limiter refusal, `Retry-After: 60` |

Valid input with unavailable NVIDIA still returns 200, `source: "rules"`, and an honest warning. Provider HTTP 401 is labeled an authentication failure, 403 an access/permission refusal, 429 a rate limit; upstream response bodies and secret values are not exposed. Fallback is deterministic for the same replay/mode and warning condition. It includes 2–3 observations, a next experiment, and limitations. At a horizon with no events, observation ID arrays can be empty; the limitations state that no trace evidence exists yet.

## Provider behavior

One non-streaming HTTPS POST is made to the server-configured base URL's `/chat/completions` endpoint. Redirects are rejected. There are **no automatic retries** and no alternate paid provider. The deadline is **18 seconds**, including body parsing, enforced with abort plus a timeout race. Route max duration is 25 seconds; the frontend example uses 22 seconds. The response body is limited to 65,536 bytes; message content to 6,000 characters. The output budget is 1,200 tokens for hosted inference and 800 for the prepared Brev deployment.

The provider supplies content only. The server owns source/warning provenance. Zod checks the JSON object's exact shape, 2–3 observations, bounded strings and arrays, and at least one event reference per provider observation. Every reference must be one of the actual supplied IDs with `primary:` or `comparison:` namespace. Unknown or cross-branch invented IDs cause rules fallback. `reasoning_content` is never used as the answer. The server does not log provider bodies or internal error details.

Schema validation and references constrain the output; they do not prove every free-text inference true. A conservative forbidden-claim check rejects percentage/readiness/employability patterns; it is not a complete semantic safety guarantee. The prompt requires facts only, concise English, no personal diagnosis or employment prediction, no invented metrics, and one testable experiment. Learners can open the cited trace events to assess the explanation.

The explicit structured-output allowlist currently contains `nvidia/nemotron-3.5-super-vl-120b-a12b`, whose [hosted reference documents JSON schema](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3_5-super-vl-120b-a12b-infer). Other configured models use JSON prompting followed by the same strict validation. The [GPT-OSS-120B reference](https://docs.api.nvidia.com/nim/reference/openai-gpt-oss-120b-infer) and [20B reference](https://docs.api.nvidia.com/nim/reference/openai-gpt-oss-20b-infer) document their hosted model IDs and reasoning controls but do not establish schema support. Real inference must be checked for the selected model with `npm run smoke:coach`. No model is selected implicitly when `NVIDIA_MODEL` is missing.

### Self-hosted NVIDIA model in Brev

`NVIDIA_DEPLOYMENT=hosted` is the default. The explicit `brev` mode supports `NVIDIA_MODEL=nvidia/NVIDIA-Nemotron-Nano-9B-v2` on the prepared vLLM gateway. An unrecognized deployment or a different Brev model fails to rules without contacting a provider; this does not silently claim that another vendor's model is NVIDIA. Contract v1 remains unchanged: successful NVIDIA-model inference returns `source: "nvidia"`, while the server prepends `Self-hosted NVIDIA model on Brev; this is not the NVIDIA-hosted API.` to `limitations` (keeping the array within its four-item bound). Show that provenance with the coach explanation. A failed inference still returns the honest `source: "rules"` fallback.

The three existing server-only variables have the following meanings in this mode:

- `NVIDIA_API_KEY`: the authentication token for **your own gateway**, not a Brev organization API key, NVIDIA account credential, or NIM hosted API key.
- `NVIDIA_BASE_URL`: the gateway's externally reachable HTTPS URL ending in `/v1`. Brev mode requires an explicit URL and rejects the hosted `integrate.api.nvidia.com` address. Keep the token out of URLs. Browser-login redirects are rejected.
- `NVIDIA_MODEL`: exactly `nvidia/NVIDIA-Nemotron-Nano-9B-v2` for this adapter.

The provider sends vLLM's `response_format: { type: "json_schema", ... }`, requests greedy decoding and up to 800 output tokens, and puts `/no_think` in the system message. The [official NVIDIA model card](https://huggingface.co/nvidia/NVIDIA-Nemotron-Nano-9B-v2) documents the `/no_think` message switch; its template does not use the Qwen-style `enable_thinking` setting. Hosted Nemotron 3.5's `reasoning_effort` is not sent to the self-hosted Nano model. [vLLM documents JSON Schema output](https://docs.vllm.ai/en/latest/features/structured_outputs/). These request settings do not establish real latency or explanation quality: verify the running GPU endpoint after warm-up, then run the full application smoke. No real Brev inference has been verified by the offline tests.

`npm run smoke:coach` loads production Next.js env precedence, makes a small direct request and validates exactly `{"ok":true}`. In Brev mode it uses the same model ID, gateway token, `/no_think`, and JSON Schema path. It prints only the result category, deployment kind and elapsed time; it does not print a response body or secrets. `npm run smoke` remains the proof for grounded coach schema and trace references, rather than just inference access.

## Public coach budget

The handler's process-local limiter permits up to 6 valid coach requests per client key per 60-second window, 60 globally per process/window, and 2 in flight. It stores at most 1,000 client keys and releases concurrency in a finally block, including on provider failure. Simulation endpoints do not exist; replay is local/browser-side.

This is best-effort, **not distributed protection**: cold starts/new instances reset or multiply budgets. Client keys use the first forwarded IP when available; that value is trustworthy only behind a proxy that overwrites untrusted forwarding headers. The global and concurrency caps remain process-local even when client identity is spoofed. For broader public traffic, configure a platform WAF or a separately authorized shared limiter. No shared limiter, paid service, or new account was provisioned by this implementation.


## Verify the actual application coach

After `npm run build`, run `npm run smoke`. It launches a temporary production server, submits exactly one real A/B coach request (seed 42, horizon 120000, API replicas 4 versus maximum attempts 1 at 20000), and shuts down the temporary server. `source: rules` fails the command even with HTTP 200. Success requires the same content schema and every event reference in the proper replay namespace; the redacted response and computed metrics are saved in ignored `.next/incidentlab-smoke.json`. Review the English explanation against those metrics; schema/reference checks alone do not prove all prose true.

For an actual published server, use `INCIDENTLAB_SMOKE_URL=https://<actual-origin> npm run smoke`. The URL must be a public HTTPS origin; redirect-to-login fails. Remote health must report configured NVIDIA variables. Local secrets are not sent by this script to the application; only the server-side hosting configuration controls the remote provider call. Each execution makes one coach POST and has no provider retry loop. Test fixtures exercise this command offline in isolated temporary directories and are not live inference evidence.
