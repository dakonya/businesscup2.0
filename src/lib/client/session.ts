import type {
  Controls,
  Intervention,
  RunSpec,
  SavedAttempt,
  SavedSession,
  ScenarioDefinition,
} from "../contracts";
import { validateRunSpec } from "../sim";

export const STORAGE_KEY = "incidentlab.session.v1";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);
const isId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const isLabel = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 100;

function cloneAttempt(attempt: SavedAttempt): SavedAttempt {
  return {
    ...attempt,
    spec: { ...attempt.spec, actions: attempt.spec.actions.map((action) => ({ ...action })) },
  };
}

/** Decode saved state through the current engine scenario definitions. */
export function validateSession(
  value: unknown,
  scenarios: ScenarioDefinition[],
): SavedSession | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !isId(value.activeAttemptId) ||
    !Array.isArray(value.attempts) ||
    value.attempts.length === 0 ||
    value.attempts.length > 100
  ) return null;

  const ids = new Set<string>();
  const attempts: SavedAttempt[] = [];
  for (const candidate of value.attempts) {
    if (
      !isRecord(candidate) || !isId(candidate.id) || ids.has(candidate.id) ||
      !isLabel(candidate.label) || !isRecord(candidate.spec) ||
      candidate.spec.schemaVersion !== 1 || !isInteger(candidate.spec.seed) ||
      !Array.isArray(candidate.spec.actions)
    ) return null;
    const spec = candidate.spec;
    const scenario = scenarios.find((item) => item.id === spec.scenarioId);
    if (
      !scenario || !isInteger(candidate.cursorMs) ||
      candidate.cursorMs < 0 || candidate.cursorMs > scenario.durationMs
    ) return null;
    // Enforce the engine's input limits before walking untrusted action arrays.
    try {
      validateRunSpec(spec as unknown as RunSpec, candidate.cursorMs);
    } catch {
      return null;
    }

    let previousAtMs = -1;
    const actions: Intervention[] = [];
    for (const action of spec.actions as unknown[]) {
      if (
        !isRecord(action) || !isInteger(action.atMs) ||
        action.atMs < previousAtMs || action.atMs < 0 || action.atMs > scenario.durationMs ||
        !isInteger(action.value)
      ) return null;
      const control = scenario.controls.find((item) => item.type === action.type);
      if (!control || !control.values.includes(action.value)) return null;
      actions.push({ type: control.type, atMs: action.atMs, value: action.value });
      previousAtMs = action.atMs;
    }
    ids.add(candidate.id);
    attempts.push({
      id: candidate.id,
      label: candidate.label.trim().replace(/^Attempt ([A-Z])$/, "Попытка $1"),
      cursorMs: candidate.cursorMs,
      spec: { schemaVersion: 1, scenarioId: scenario.id, seed: candidate.spec.seed, actions },
    });
  }
  if (!ids.has(value.activeAttemptId)) return null;
  // A session is one experiment: attempts must share the same workload.
  if (attempts.some((attempt) =>
    attempt.spec.scenarioId !== attempts[0].spec.scenarioId ||
    attempt.spec.seed !== attempts[0].spec.seed
  )) return null;
  return { schemaVersion: 1, activeAttemptId: value.activeAttemptId, attempts };
}

export function createAttempt(
  scenario: ScenarioDefinition,
  seed: number,
  id: string = globalThis.crypto.randomUUID(),
  label = "Попытка A",
): SavedAttempt {
  if (!isId(id) || !isLabel(label)) {
    throw new Error("Не удалось создать попытку. Начни тренировку заново.");
  }
  const attempt: SavedAttempt = {
    id,
    label: label.trim(),
    cursorMs: 0,
    spec: { schemaVersion: 1, scenarioId: scenario.id, seed, actions: [] },
  };
  validateRunSpec(attempt.spec, attempt.cursorMs);
  return attempt;
}

export function readSession(
  storage: Pick<Storage, "getItem">,
  scenarios: ScenarioDefinition[],
): { session: SavedSession | null; error: string | null } {
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return { session: null, error: "Браузер не даёт открыть сохранённую тренировку. Начни новую." };
  }
  if (raw === null) return { session: null, error: null };
  try {
    const session = validateSession(JSON.parse(raw), scenarios);
    return session
      ? { session, error: null }
      : { session: null, error: "Сохранение повреждено или устарело. Начни новую тренировку." };
  } catch {
    return { session: null, error: "Не удалось прочитать сохранение. Начни новую тренировку." };
  }
}

export function writeSession(
  storage: Pick<Storage, "setItem">,
  session: SavedSession,
): string | null {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(session));
    return null;
  } catch {
    return "Не удалось сохранить тренировку. После перезагрузки изменения могут пропасть — пока продолжай в этой вкладке.";
  }
}

/** Fork at the boundary, excluding actions exactly on the checkpoint. */
export function forkAttempt(
  source: SavedAttempt,
  checkpointMs: number,
  id: string,
  label: string,
): SavedAttempt {
  if (
    !isInteger(checkpointMs) || checkpointMs < 0 || checkpointMs > source.cursorMs ||
    !isId(id) || id === source.id || !isLabel(label)
  ) throw new Error("Сначала дойди до точки, от которой хочешь начать новую попытку.");
  const next = cloneAttempt(source);
  next.id = id;
  next.label = label.trim();
  next.cursorMs = checkpointMs;
  next.spec.actions = next.spec.actions.filter((action) => action.atMs < checkpointMs);
  return next;
}

/** Only the present can be edited. The UI must explicitly fork to edit history. */
export function appendIntervention(
  attempt: SavedAttempt,
  action: Intervention,
): SavedAttempt {
  const lastAction = attempt.spec.actions.at(-1);
  if (
    !isInteger(action.atMs) || !isInteger(action.value) || action.atMs < 0 ||
    action.atMs !== attempt.cursorMs || (lastAction && action.atMs < lastAction.atMs)
  ) throw new Error("Чтобы изменить прошлое решение, создай новую попытку.");
  if (!CONTROL_KEYS[action.type]) throw new Error("Эта настройка недоступна.");
  const lastOfType = [...attempt.spec.actions].reverse().find((item) => item.type === action.type);
  // Also makes repeated clicks idempotent after playback has resumed.
  if (lastOfType?.value === action.value) return attempt;
  const next = cloneAttempt(attempt);
  next.spec.actions.push({ ...action });
  validateRunSpec(next.spec, next.cursorMs);
  return next;
}

export const CONTROL_KEYS: Record<Intervention["type"], keyof Controls> = {
  "set-api-replicas": "apiReplicas",
  "set-max-attempts": "maxAttempts",
  "set-retry-backoff": "retryBackoffMs",
};

export function controlsAt(attempt: SavedAttempt, scenario: ScenarioDefinition): Controls {
  const controls = { ...scenario.defaultControls };
  for (const action of attempt.spec.actions) {
    if (action.atMs <= attempt.cursorMs) controls[CONTROL_KEYS[action.type]] = action.value;
  }
  return controls;
}
