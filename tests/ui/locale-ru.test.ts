import { describe, expect, it } from "vitest";
import { getScenarios, simulateRun } from "../../src/lib/sim";
import { dataLabel, dataValue, errorMessage, eventKind, eventMessage, localizeScenario } from "../../src/lib/client/locale-ru";

describe("Russian presentation preserves simulation data", () => {
  it("translates scenario copy without changing its machine contract", () => {
    const source = getScenarios()[0];
    const snapshot = structuredClone(source);
    const russian = localizeScenario(source);
    expect(russian.title).toBe("Замедление каталога");
    expect(russian.id).toBe(source.id);
    expect(russian.durationMs).toBe(source.durationMs);
    expect(russian.checkpointMs).toBe(source.checkpointMs);
    expect(russian.defaultControls).toEqual(source.defaultControls);
    expect(russian.controls.map(({ type, values }) => ({ type, values }))).toEqual(source.controls.map(({ type, values }) => ({ type, values })));
    expect(source).toEqual(snapshot);
  });

  it("localizes every real trace kind, preserving identifiers and computed values", () => {
    const scenario = getScenarios()[0];
    const view = simulateRun({ schemaVersion: 1, scenarioId: scenario.id, seed: 42, actions: [{ atMs: scenario.checkpointMs, type: "set-api-replicas", value: 4 }] }, scenario.durationMs);
    const eventsByKind = new Map(view.events.map(event => [event.kind, event]));
    expect(eventsByKind.size).toBeGreaterThan(10);
    for (const event of eventsByKind.values()) {
      expect(eventKind(event.kind)).not.toBe("Событие системы");
      expect(eventMessage(event)).toMatch(/[А-Яа-яЁё]/);
      expect(eventMessage(event)).not.toBe("Событие из текущего прогона.");
      expect(event.id).toContain(":");
    }
    expect(dataLabel("retryAtMs")).toBe("Время повтора, мс");
    expect(dataValue("type", "set-api-replicas")).toBe("Реплики API");
  });

  it("shows translated controlled errors and hides unknown English errors", () => {
    expect(errorMessage(new Error("Actions must be an array with at most 64 entries."), "Ошибка")).toContain("64");
    expect(errorMessage(new Error("unexpected internal error"), "Не удалось воспроизвести попытку.")).toBe("Не удалось воспроизвести попытку.");
    expect(errorMessage(new Error("Создайте новую ветку."), "Ошибка")).toBe("Создайте новую ветку.");
  });
});
