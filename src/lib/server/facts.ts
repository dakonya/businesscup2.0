import type { CoachRequest, CoachResponse, RunView, TraceEvent } from "../contracts";
import { compareRuns, getScenarios, simulateRun } from "../sim";

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
  const triedAttempts = new Set([primary.controls.maxAttempts, ...(comparison ? [comparison.controls.maxAttempts] : [])]);
  const attemptValues = getScenarios().find(scenario => scenario.id === input.primary.scenarioId)!
    .controls.find(control => control.type === "set-max-attempts")!.values;
  const nextAttempts = attemptValues.find(value => !triedAttempts.has(value));
  const observations: CoachResponse["observations"] = [{
    text: `К отметке ${input.untilMs} мс поступило ${primary.metrics.arrived} запросов: успешных — ${primary.metrics.succeeded}, с ошибкой — ${primary.metrics.failed}, в ожидании — ${primary.metrics.pending}. Ожидающие запросы ещё не завершились.`,
    evidenceEventIds: (forKind("request-failed").length ? forKind("request-failed") : available),
  }];
  if (comparison && delta) observations.push({
    text: `В сравниваемой попытке успешных ответов — ${comparison.metrics.succeeded}, ошибок — ${comparison.metrics.failed}, в ожидании — ${comparison.metrics.pending}. Разница с основной попыткой: успешные ответы ${delta.succeeded}, ошибки ${delta.failed}, обращения к базе ${delta.totalAttempts}. Поток запросов и время сравнения одинаковые.`,
    evidenceEventIds: [...available.slice(0, 1), ...evidence.filter(e => e.id.startsWith("comparison:")).map(e => e.id).slice(-1)],
  });
  else if (lowHint) observations.push({ text: "Посмотри, когда появились первые ошибки, и открой историю запроса из этого периода.", evidenceEventIds: available });
  else observations.push({
    text: input.mode === "debrief" ? `За прогон создано ${primary.metrics.totalAttempts} обращений к базе, из них ${primary.metrics.retries} — повторные. После тайм-аута база продолжает выполнять обращение, а его запоздалый результат отбрасывается.` : `Повторных обращений: ${primary.metrics.retries}. Сравни первый тайм-аут с более поздним завершением того же обращения к базе.`,
    evidenceEventIds: [...forKind("attempt-timeout").slice(0, 1), ...forKind("late-response").slice(0, 1)].length ? [...forKind("attempt-timeout").slice(0, 1), ...forKind("late-response").slice(0, 1)] : available,
  });
  if (comparison && !lowHint && input.mode === "debrief") observations.push({
    text: `В основной попытке повторов — ${primary.metrics.retries}, очередь БД — ${primary.metrics.dbQueue}, активных операций — ${primary.metrics.dbActive}. В сравниваемой попытке повторов — ${comparison.metrics.retries}, очередь БД — ${comparison.metrics.dbQueue}, активных операций — ${comparison.metrics.dbActive}. Таймаут не отменяет работу БД. Пустая очередь не означает, что все запросы уже завершились.`,
    evidenceEventIds: [...forKind("attempt-timeout").slice(0, 1), ...forKind("late-response").slice(0, 1)].length ? [...forKind("attempt-timeout").slice(0, 1), ...forKind("late-response").slice(0, 1)] : available,
  });
  return {
    source: "rules", summary: input.mode === "hint" ? "Посмотри на результаты запросов и выбери, что проверить дальше." : "Разбор показывает, как настройки API и повторных обращений влияют на очередь в базе и ответы пользователям.",
    observations,
    nextExperiment: lowHint ? "Останови прогон у первого запроса с ошибкой и изучи его историю. Запиши гипотезу, прежде чем менять настройки." : input.mode === "hint" && input.hintLevel === 2 ? "На контрольной точке измени одну настройку повторов. Сравни обе попытки на одной отметке времени и с тем же начальным числом." : nextAttempts === undefined ? "Все допустимые значения максимума попыток уже проверены. Изучи различия в событиях перед следующим экспериментом." : `Повтори основную попытку, изменив только максимум попыток на ${nextAttempts} с контрольной точки. Остальные решения и время их применения сохрани. Сравни новый прогон с исходной основной попыткой при том же начальном числе и горизонте: успешные ответы, ошибки, ожидание и обращения к базе.`,
    limitations: ["Модель упрощает работу системы. По этим результатам нельзя предсказать поведение реального сервиса.", "Задержки рассчитаны только для успешных ответов. Учитывай также запросы с ошибкой и те, что ещё ждут ответа.", ...(evidence.length ? [] : ["К этой отметке времени событий ещё нет."])], warning,
  };
}
