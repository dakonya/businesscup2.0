import type { CoachRequest, CoachResponse, RunView, TraceEvent } from "../contracts";
import { compareRuns, simulateRun } from "../sim";

export function buildFacts(input: CoachRequest) {
  const compared = input.comparison ? compareRuns(input.primary, input.comparison, input.untilMs) : undefined;
  const primary = compared?.left ?? simulateRun(input.primary, input.untilMs);
  const comparison = compared?.right;
  const lowHint = input.mode === "hint" && (input.hintLevel ?? 1) === 1;
  const interesting = (event: TraceEvent) => lowHint
    ? ["arrival", "request-succeeded", "request-failed", "intervention"].includes(event.kind)
    : ["intervention", "db-slowdown", "db-recovered", "attempt-timeout", "late-response", "request-succeeded", "request-failed", "retry-scheduled"].includes(event.kind);
  const sample = (run: RunView, namespace: "primary" | "comparison") => {
    const candidates = run.events.filter(interesting);
    const anchor = candidates.filter(e => ["intervention", "db-slowdown", "db-recovered"].includes(e.kind));
    const representative = ["request-failed", "attempt-timeout", "late-response", "retry-scheduled", "request-succeeded"]
      .flatMap(kind => { const event = candidates.find(e => e.kind === kind); return event ? [event] : []; });
    const selected = [...anchor.slice(0, 4), ...anchor.slice(-4), ...representative, ...candidates.slice(0, 1), ...candidates.slice(-10)];
    return [...new Map(selected.map(e => [e.id, e])).values()].sort((a, b) => a.atMs - b.atMs)
      .map(e => ({ ...e, id: `${namespace}:${e.id}` }));
  };
  const evidence = [...sample(primary, "primary"), ...(comparison ? sample(comparison, "comparison") : [])];
  return { primary, comparison, delta: compared?.delta, evidence, allowedIds: new Set(evidence.map(e => e.id)), lowHint };
}
export type Facts = ReturnType<typeof buildFacts>;
export function rulesCoach(input: CoachRequest, facts: Facts, warning: string): CoachResponse {
  const { primary, comparison, delta, lowHint, evidence } = facts;
  const forKind = (kind: string, namespace = "primary") => evidence.filter(e => e.id.startsWith(`${namespace}:`) && e.kind === kind).map(e => e.id).slice(0, 2);
  const available = evidence.map(e => e.id).slice(0, 2);
  const observations: CoachResponse["observations"] = [{
    text: `At ${input.untilMs} ms, ${primary.metrics.arrived} customers arrived: ${primary.metrics.succeeded} succeeded, ${primary.metrics.failed} failed, and ${primary.metrics.pending} are still pending. Pending customers are not failures.`,
    evidenceEventIds: (forKind("request-failed").length ? forKind("request-failed") : available),
  }];
  if (comparison && delta) observations.push({
    text: `The comparison changes successes by ${delta.succeeded}, failures by ${delta.failed}, and database attempts by ${delta.totalAttempts}, under identical arrivals. Deltas are comparison minus primary.`,
    evidenceEventIds: [...available.slice(0, 1), ...evidence.filter(e => e.id.startsWith("comparison:")).map(e => e.id).slice(-1)],
  });
  else if (lowHint) observations.push({ text: "Inspect customer outcomes over time and open one request trace around the first failure before choosing a control.", evidenceEventIds: available });
  else observations.push({
    text: input.mode === "debrief" ? `The run created ${primary.metrics.totalAttempts} database attempts, including ${primary.metrics.retries} retries. Timed-out database work continues; its late response cannot rescue that attempt.` : `The run has ${primary.metrics.retries} retries. Compare the first timeout and a later database completion for the same attempt.`,
    evidenceEventIds: [...forKind("attempt-timeout").slice(0, 1), ...forKind("late-response").slice(0, 1)].length ? [...forKind("attempt-timeout").slice(0, 1), ...forKind("late-response").slice(0, 1)] : available,
  });
  if (comparison && !lowHint && input.mode === "debrief") observations.push({
    text: `Primary created ${primary.metrics.retries} retries. Timed-out database work is retained, and late completion cannot restore a lost response. More API admission can add database pressure in this scenario.`,
    evidenceEventIds: [...forKind("attempt-timeout").slice(0, 1), ...forKind("late-response").slice(0, 1)].length ? [...forKind("attempt-timeout").slice(0, 1), ...forKind("late-response").slice(0, 1)] : available,
  });
  return {
    source: "rules", summary: input.mode === "hint" ? "Use the observed customer outcomes to choose your next investigation step." : "This replay shows how admission, database capacity, and retries interact in this scenario.",
    observations,
    nextExperiment: lowHint ? "Pause at the first failed request and inspect its attempt timeline. Record one hypothesis before changing a control." : input.mode === "hint" && input.hintLevel === 2 ? "Change only one retry control at the checkpoint, then compare both runs at the same horizon and seed." : `Replay from the checkpoint with maximum attempts set to ${primary.controls.maxAttempts === 1 ? 2 : 1}. Keep the same seed and horizon; compare successes, failures, pending customers, and database attempts.`,
    limitations: ["This is a simplified queueing simulation, not a prediction of production behavior.", "Latency statistics include successful customers only; read failures and pending counts alongside them.", ...(evidence.length ? [] : ["No trace events exist yet at this replay horizon."])], warning,
  };
}
