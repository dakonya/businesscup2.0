# Catalog slowdown: simulation model

The scenario is a bounded discrete-event teaching model. It computes customer outcomes from admission limits, queues, database service times, attempt deadlines, and retry policy. Intervention handlers change controls; they do not directly change success counts or draw chart values.

## Parameters and external traffic

| Parameter | Value |
| --- | --- |
| Scenario ID / title | `catalog-slowdown` / Catalog slowdown |
| Scenario horizon | 120,000 model milliseconds |
| Suggested checkpoint | 20,000 ms |
| Default controls | 2 API replicas; 3 total attempts; 50 ms retry backoff |
| API admission capacity | 6 concurrent waiting attempts per replica |
| Database workers | 4, with one active operation per worker |
| Normal database service time | 300–400 ms, inclusive, per operation |
| Attempt response deadline | 1,000 ms after admission to the database queue |
| Database slowdown | Operations starting in `[15000, 23000)` take 8 times their normal service time |
| Customer arrival spacing | 125 ms plus a stable 0–40 ms offset within each arrival slot |
| Chart interval | 500 ms, plus the exact requested final horizon |

For request index `i`, the arrival time is `80 + 125*i + hash(seed, "arrival:" + requestId) % 41`. Request IDs follow `r0000`, `r0001`, and so on. Every supported seed produces 960 customer arrivals over this scenario. Seeds change individual arrival offsets and operation service times. Traffic generation does not consume a mutable random-number stream.

Before the incident, approximately 8 new customers arrive per second, while the database's normal mean service capacity is approximately 11.4 operations per second. Healthy first attempts finish within their deadline. During overload, retries add database operations without adding customers. Raising the API admission limit can let more of those operations reach the database. This behavior follows this scenario's parameters; API scaling does not universally worsen production incidents.

The slowdown multiplier is selected when a worker starts an operation. An operation already running before 15,000 ms retains its normal duration. An operation started just before 23,000 ms retains its longer duration after the slowdown window ends. The model does not continuously recompute work progress when capacity changes.

## Request and attempt lifecycle

1. A new customer enters the FIFO API admission queue. Its unique request is `pending`.
2. When API capacity is available, the API creates an attempt and submits it to the FIFO database queue. This increments `totalAttempts`; attempts beyond that customer's first also increment `retries`. Attempt IDs are stable, such as `r0123/a2`.
3. The attempt's 1,000 ms deadline starts at database submission. It includes database queueing and service, but excludes time spent waiting for API admission. An available database worker starts the queued operation.
4. If the database operation completes while the API still awaits that attempt, the customer succeeds. Latency is completion time minus the original customer arrival time, so it includes any earlier API queueing, retry waits, and attempts.
5. At an attempt timeout, the API stops awaiting the response and releases its admission slot. The database operation is **not cancelled**, whether queued or running. If the current maximum attempt budget is exhausted, the unique customer fails. Otherwise a retry is scheduled using the backoff value at that timeout.
6. A due retry joins the same FIFO API queue as new customers. The attempt budget is checked again when it reaches admission. If a later policy change exhausted its budget, the customer fails without creating another database operation.
7. A timed-out operation's eventual completion produces a `late-response` event and is discarded. It cannot succeed that customer, including when the customer is still awaiting another attempt. Failed and successful customer states are terminal.

There is no separate end-to-end customer deadline, queue capacity, or queue rejection rule. A customer waiting for API admission or retry backoff can remain pending at the final scenario horizon. This is deliberate and visible; pending customers must not be counted as failed. `finished: true` means the replay reached the scenario horizon, not that every customer and operation drained.

The invariants are:

```text
arrived = succeeded + failed + pending
sum(request.attempts) = totalAttempts
sum(max(0, request.attempts - 1)) = retries
```

A unique customer cannot simultaneously succeed and fail. Database work and user-visible requests have different lifetimes and counts.

## Control changes and event ordering

Allowed values come from `getScenarios()[0].controls`:

| Intervention | Allowed values |
| --- | --- |
| `set-api-replicas` | 1, 2, 4, 8 |
| `set-max-attempts` | 1, 2, 3, including the first attempt |
| `set-retry-backoff` | 0, 50, 250, 1,000, 2,000 ms |

Reducing replicas retains active waiting attempts. New admission waits until the active count is below the new capacity. Reducing the attempt budget does not cancel an already awaited attempt or its database operation. Changing backoff does not move an already scheduled retry; the new value applies at subsequent timeouts.

All times are integer model milliseconds. Events exactly on `untilMs` are included. For a shared timestamp, the heap processes:

1. Interventions, in their input array order. All same-time controls are applied before queued work is admitted; the last write to a control wins.
2. Slowdown boundary events.
3. Database completions. A completion exactly on its response deadline succeeds before its timeout is processed.
4. Attempt timeouts.
5. Due retries and admission pumps triggered by interventions, in stable insertion order.
6. Customer arrivals.
7. Chart samples.

FIFO queue pumping can occur synchronously while an event is processed. For example, a completion releases capacity and immediately starts eligible queued work. The event heap resolves otherwise equal keys by insertion order.

## Determinism, rewind, and comparison

The engine uses integer hashing of the seed and stable request or attempt identities. It does not call `Math.random`, `Date.now`, a network, server configuration, or environment variables. A retry cannot shift future customer arrivals or another attempt's base service sample. A policy can change when an operation starts and thus whether that operation encounters the slowdown.

`simulateRun(spec, untilMs)` replays from the beginning without mutating its input. Chart samples do not generate trace IDs, so a shorter replay's trace remains the prefix of a longer replay under the same specification. Scenario metadata is returned as an independent copy.

`forkRun(A, checkpointMs)` copies the same scenario and seed, retaining only actions with `atMs < checkpointMs`. An A action exactly at the checkpoint is deliberately absent from B. The caller can add B's new action at that checkpoint. A remains unchanged. Comparing a restored checkpoint to A's inclusive checkpoint only gives identical controls when A has no action exactly on the checkpoint; compare to A's strictly earlier action history when it does.

`compareRuns(A, B, untilMs)` requires equal scenario and seed, then replays both to the same horizon. Every delta is **B minus A**. A negative failed delta means fewer failures in B. Unsupported scenarios, invalid controls, descending action times, more than 64 actions, non-integer or out-of-range seeds, and horizons outside `[0, 120000]` raise `SimulationInputError`. Future actions are validated even when their timestamp lies beyond the current replay horizon.

## Reading the output honestly

`events` contains the full emitted trace and `requests` the full customer summary through the requested horizon. `series` starts at 0, uses 500 ms intervals, and contains the exact final horizon once. A non-aligned final interval may be shorter than 500 ms. Queue and worker counts are engine state, not decorative chart data.

Average and p95 latency include successful customers only, and are `null` if none succeeded. p95 uses the nearest-rank sorted successful latency. A heavily failing run can display a low successful p95 because slow customers never received successful responses. Always show failed and pending counts beside latency; latency alone is not a reliability score.

The model has a single service, one database, fixed workers, FIFO queues, synthetic traffic, fixed admission slots, no network jitter beyond deterministic service variation, no resource costs, no cancellation intervention, no autoscaler, and no real infrastructure. It is suitable for controlled experiments about this failure mechanism. It does not establish production tuning guidance, professional readiness, employment outcomes, or a personal diagnosis.

## Reproduced experiment

Run `npm run demo`. At seed **42**, compare the following actions at **20,000 ms**, with a shared horizon of **120,000 ms**:

- A: `set-api-replicas = 4`.
- B: `set-max-attempts = 1`.

| Computed metric | No intervention | A: scale API | B: limit attempts |
| --- | ---: | ---: | ---: |
| Arrived customers | 960 | 960 | 960 |
| Succeeded | 120 | 120 | 709 |
| Failed | 270 | 800 | 248 |
| Pending | 570 | 40 | 3 |
| Total database attempts | 1,376 | 2,588 | 987 |
| Retries | 673 | 1,632 | 27 |
| Final API queue | 557 | 6 | 0 |
| Final database queue | 144 | 1,355 | 0 |
| Active database operations | 4 | 4 | 3 |
| Successful p95 latency (ms) | 394 | 394 | 397 |

B minus A gives **589 more successes**, **552 fewer failures**, and **1,601 fewer database attempts**. B still loses 248 customer responses; it does not undo previous failures. Its 27 retries were created before the policy change. These values are deterministic results of this engine, seed, policies, and horizon. Tests assert the useful intervention relationally and verify accounting; they do not steer the engine toward a preselected score.

A local Node 24 run on 2026-11-14 measured **64.35 ms** for the two full replays, excluding the baseline replay and JSON serialization. This is one machine/run observation, not a browser performance guarantee. A returned 12,130 trace events and B returned 5,466; their serialized view lengths were 2,559,271 and 1,107,481 characters respectively. Keep these full histories for request inspection, but paginate or filter trace rendering, avoid replaying on every animation frame, and send only the server-selected evidence subset to the coach. Measure on the target browser before deciding whether a Web Worker or incremental replay is necessary.
