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
    text: `К ${input.untilMs} мс поступило запросов пользователей: ${primary.metrics.arrived}. Успешных ответов: ${primary.metrics.succeeded}, ошибок: ${primary.metrics.failed}, ещё ожидают ответа: ${primary.metrics.pending}. Ожидание не считается ошибкой.`,
    evidenceEventIds: (forKind("request-failed").length ? forKind("request-failed") : available),
  }];
  if (comparison && delta) observations.push({
    text: `При одинаковом входящем потоке изменение успешных ответов составляет ${delta.succeeded}, ошибок — ${delta.failed}, обращений к базе данных — ${delta.totalAttempts}. Каждая разница вычислена как результат сравниваемой попытки минус результат основной.`,
    evidenceEventIds: [...available.slice(0, 1), ...evidence.filter(e => e.id.startsWith("comparison:")).map(e => e.id).slice(-1)],
  });
  else if (lowHint) observations.push({ text: "Посмотрите, как менялись результаты запросов, и откройте историю одного запроса возле первой ошибки, прежде чем менять настройки.", evidenceEventIds: available });
  else observations.push({
    text: input.mode === "debrief" ? `В этой попытке создано обращений к базе данных: ${primary.metrics.totalAttempts}, в том числе повторных: ${primary.metrics.retries}. После тайм-аута работа в базе продолжается, но запоздалый ответ уже не спасает это обращение.` : `Повторных обращений: ${primary.metrics.retries}. Сравните первый тайм-аут и более позднее завершение работы базы для одного и того же обращения.`,
    evidenceEventIds: [...forKind("attempt-timeout").slice(0, 1), ...forKind("late-response").slice(0, 1)].length ? [...forKind("attempt-timeout").slice(0, 1), ...forKind("late-response").slice(0, 1)] : available,
  });
  if (comparison && !lowHint && input.mode === "debrief") observations.push({
    text: `В основной попытке создано повторных обращений: ${primary.metrics.retries}. Работа в базе сохраняется после тайм-аута, а её позднее завершение не восстанавливает потерянный ответ. В этом сценарии допуск большего числа обращений через API может увеличить нагрузку на базу.`,
    evidenceEventIds: [...forKind("attempt-timeout").slice(0, 1), ...forKind("late-response").slice(0, 1)].length ? [...forKind("attempt-timeout").slice(0, 1), ...forKind("late-response").slice(0, 1)] : available,
  });
  return {
    source: "rules", summary: input.mode === "hint" ? "Используйте результаты запросов, чтобы выбрать следующий шаг расследования." : "Этот прогон показывает, как связаны допуск обращений, пропускная способность базы данных и повторные попытки.",
    observations,
    nextExperiment: lowHint ? "Остановитесь возле первого неуспешного запроса и изучите историю его обращений. Запишите одну гипотезу, прежде чем менять настройки." : input.mode === "hint" && input.hintLevel === 2 ? "Измените только одну настройку повторов на контрольной точке, затем сравните оба прогона при одинаковом времени и начальном числе." : `Повторите прогон от контрольной точки: задайте максимум попыток ${primary.controls.maxAttempts === 1 ? 2 : 1}. Сохраните то же начальное число и время сравнения; сопоставьте успешные ответы, ошибки, ожидающие запросы и обращения к базе данных.`,
    limitations: ["Это упрощённая модель очередей. Она не предсказывает поведение рабочей системы.", "Статистика задержек учитывает только успешные ответы; рассматривайте её вместе с числом ошибок и ожидающих запросов.", ...(evidence.length ? [] : ["На этом моменте прогона ещё нет событий для изучения."])], warning,
  };
}
