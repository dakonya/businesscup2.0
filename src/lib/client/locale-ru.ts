import type { Intervention, ScenarioDefinition, TraceEvent } from "../contracts";

export const formatCount = (value: number) => value.toLocaleString("ru-RU");
export const formatSeconds = (ms: number) => `${(ms / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 3 })} с`;
export const attemptLabel = (label: string) => label.replace(/^Attempt ([A-Z])$/, "Попытка $1");

const controls: Record<Intervention["type"], { label: string; description: string }> = {
  "set-api-replicas": { label: "Реплики API", description: "Каждая реплика допускает шесть одновременных попыток. При уменьшении числа реплик текущая работа сохраняется." },
  "set-max-attempts": { label: "Максимум попыток", description: "Включая первую попытку. Лимит проверяется при таймауте и перед запуском повтора." },
  "set-retry-backoff": { label: "Задержка повтора, мс", description: "Пауза перед повторной попыткой. Уже запланированные повторы сохраняют назначенное время." },
};

/** Presentation only: preserve the engine's timing, controls, ranges and scenario ID. */
export function localizeScenario(scenario: ScenarioDefinition): ScenarioDefinition {
  if (scenario.id !== "catalog-slowdown") return scenario;
  return {
    ...scenario,
    title: "Замедление каталога",
    briefing: "Вы дежурите на сервисе каталога. Раньше запросы выполнялись нормально, но теперь пользователи жалуются на медленные ответы и ошибки. Изучите метрики и историю запросов, проверьте изменение, затем повторите ту же нагрузку и сравните другое решение.",
    learningGoals: ["Отличать исходы пользовательских запросов от попыток обращения к БД.", "Исследовать очереди, таймауты и рост нагрузки из-за повторов.", "Сравнивать решения при одинаковой внешней нагрузке."],
    controls: scenario.controls.map(control => ({ ...control, ...controls[control.type] })),
  };
}

const kinds: Record<string, string> = {
  arrival: "Запрос поступил",
  "attempt-created": "Создана попытка",
  "db-start": "Начало операции БД",
  "db-complete": "Операция БД завершена",
  "request-succeeded": "Успешный ответ",
  "request-failed": "Ответ потерян",
  "late-response": "Поздний ответ",
  "attempt-timeout": "Таймаут попытки",
  "retry-scheduled": "Запланирован повтор",
  "db-slowdown": "Замедление БД",
  "db-recovered": "Восстановление БД",
  intervention: "Изменение настройки",
};
export const eventKind = (kind: string) => kinds[kind] ?? "Событие системы";

const messages: Record<string, string> = {
  arrival: "Поступил новый пользовательский запрос.",
  "attempt-created": "API передал попытку в очередь базы данных.",
  "db-start": "Обработчик базы данных начал операцию.",
  "db-complete": "Операция базы данных завершена.",
  "request-succeeded": "Пользователь получил успешный ответ.",
  "request-failed": "Пользователь не получил ответ: доступные попытки исчерпаны.",
  "late-response": "Операция БД завершилась после срока ожидания. Её результат отброшен.",
  "attempt-timeout": "API прекратил ожидание. Работа в очереди или в базе данных не была отменена.",
  "retry-scheduled": "Повторная попытка запланирована с текущей задержкой.",
  "db-slowdown": "Новые операции базы данных теперь требуют больше времени на обработку.",
  "db-recovered": "Время обработки новых операций БД вернулось к норме. Ранее поставленная в очередь работа сохраняется.",
};
export function eventMessage(event: TraceEvent): string {
  if (event.kind === "intervention") {
    const type = event.data?.type as Intervention["type"] | undefined;
    const label = type && controls[type] ? controls[type].label : "Настройка";
    return `${label}: установлено значение ${event.data?.value ?? "—"}.`;
  }
  return messages[event.kind] ?? "Событие зарегистрировано в истории текущего прогона.";
}

const dataLabels: Record<string, string> = {
  serviceMs: "Обработка, мс", dbActive: "Активные операции БД", dbQueue: "Очередь БД",
  attemptNumber: "Номер попытки", apiActive: "Активные попытки API", latencyMs: "Время ответа, мс",
  retryAtMs: "Время повтора, мс", factor: "Коэффициент замедления", type: "Параметр", value: "Значение",
};
export const dataLabel = (key: string) => dataLabels[key] ?? key;
export function dataValue(key: string, value: string | number | boolean): string {
  if (key === "type" && typeof value === "string" && value in controls) return controls[value as Intervention["type"]].label;
  if (typeof value === "boolean") return value ? "Да" : "Нет";
  return typeof value === "number" ? formatCount(value) : value;
}

const errors: Record<string, string> = {
  "Unsupported scenario or schema version.": "Этот сценарий или формат сохранения не поддерживается.",
  "Seed must be an integer from 0 to 4294967295.": "Сид должен быть целым числом от 0 до 4 294 967 295.",
  "Actions must be an array with at most 64 entries.": "В одной попытке допускается не более 64 изменений.",
  "Action times must be ordered integer milliseconds within the scenario.": "Изменения должны идти по порядку и находиться в пределах времени сценария.",
  "Unsupported intervention or value.": "Этот параметр или его значение не поддерживается.",
  "Replay horizon must be integer milliseconds within the scenario.": "Время просмотра должно находиться в пределах сценария.",
  "Comparison requires identical scenario and seed.": "Для сравнения нужны одинаковые сценарий и seed.",
};
export function errorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  return errors[error.message] ?? (/[А-Яа-яЁё]/.test(error.message) ? error.message : fallback);
}
