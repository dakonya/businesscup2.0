import assert from "node:assert/strict";
import { test } from "vitest";
import { STORAGE_KEY, writeSession } from "../../src/lib/client/session";
import { openTabStorage, TAB_POINTER_KEY } from "../../src/lib/client/tab-storage";

function memoryStorage(initial: Iterable<[string, string]> = []) {
  const values = new Map(initial);
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

test("reload restores the tab snapshot into a fresh key without mutating the old snapshot", () => {
  const localStorage = memoryStorage();
  const sessionStorage = memoryStorage();
  const first = openTabStorage({ localStorage, sessionStorage, createId: () => "first" });
  first.storage.setItem(STORAGE_KEY, "saved A");
  const firstKey = sessionStorage.getItem(TAB_POINTER_KEY)!;
  const reloaded = openTabStorage({ localStorage, sessionStorage, createId: () => "reload" });
  assert.equal(reloaded.warning, null);
  assert.equal(reloaded.storage.getItem(STORAGE_KEY), "saved A");
  assert.notEqual(sessionStorage.getItem(TAB_POINTER_KEY), firstKey);
  reloaded.storage.setItem(STORAGE_KEY, "saved B");
  assert.equal(localStorage.getItem(firstKey), "saved A");
  assert.equal(first.storage.getItem(STORAGE_KEY), "saved A");
});

test("a duplicated tab inherits once and then writes independently", () => {
  const localStorage = memoryStorage();
  const firstTab = memoryStorage();
  const first = openTabStorage({ localStorage, sessionStorage: firstTab, createId: () => "a" });
  first.storage.setItem(STORAGE_KEY, "original run");
  const duplicatedTab = memoryStorage(firstTab.values.entries());
  const duplicate = openTabStorage({ localStorage, sessionStorage: duplicatedTab, createId: () => "b" });
  assert.equal(duplicate.storage.getItem(STORAGE_KEY), "original run");
  duplicate.storage.setItem(STORAGE_KEY, "duplicate changed decision");
  first.storage.setItem(STORAGE_KEY, "first changed decision");
  assert.equal(duplicate.storage.getItem(STORAGE_KEY), "duplicate changed decision");
  const duplicateReload = openTabStorage({ localStorage, sessionStorage: duplicatedTab, createId: () => "b-reload" });
  assert.equal(duplicateReload.storage.getItem(STORAGE_KEY), "duplicate changed decision");
  assert.equal(first.storage.getItem(STORAGE_KEY), "first changed decision");
});

test("a separately opened tab starts fresh without overwriting another tab", () => {
  const localStorage = memoryStorage();
  const first = openTabStorage({ localStorage, sessionStorage: memoryStorage(), createId: () => "a" });
  first.storage.setItem(STORAGE_KEY, "first run");
  const second = openTabStorage({ localStorage, sessionStorage: memoryStorage(), createId: () => "b" });
  assert.equal(second.storage.getItem(STORAGE_KEY), null);
  assert.equal(first.storage.getItem(STORAGE_KEY), "first run");
});

test("untrusted pointers and colliding snapshot IDs cannot overwrite unrelated keys", () => {
  const localStorage = memoryStorage([["unrelated", "leave me"], [`${STORAGE_KEY}.tab.taken`, "other tab"]]);
  const sessionStorage = memoryStorage([[TAB_POINTER_KEY, "unrelated"]]);
  const adapter = openTabStorage({ localStorage, sessionStorage, createId: () => "taken" });
  assert.match(adapter.warning ?? "", /could not enable saving/);
  assert.equal(adapter.storage.getItem(STORAGE_KEY), null);
  assert.equal(localStorage.getItem("unrelated"), "leave me");
  assert.equal(localStorage.getItem(`${STORAGE_KEY}.tab.taken`), "other tab");
});

test("storage restrictions preserve the active session in memory and expose a save warning", () => {
  const blocked = {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); },
  };
  const adapter = openTabStorage({ localStorage: blocked, sessionStorage: blocked, createId: () => "a" });
  assert.match(adapter.warning ?? "", /Practice can continue/);
  const value = { schemaVersion: 1 as const, activeAttemptId: "a", attempts: [] };
  assert.match(writeSession(adapter.storage, value) ?? "", /could not save/);
  assert.equal(adapter.storage.getItem(STORAGE_KEY), JSON.stringify(value));
});

test("quota loss after initialization retains the newest run in memory", () => {
  const backing = memoryStorage();
  let blocked = false;
  const localStorage = {
    getItem: backing.getItem,
    setItem: (key: string, value: string) => {
      if (blocked) throw new Error("quota exceeded");
      backing.setItem(key, value);
    },
  };
  const adapter = openTabStorage({ localStorage, sessionStorage: memoryStorage(), createId: () => "a" });
  adapter.storage.setItem(STORAGE_KEY, "before quota");
  blocked = true;
  assert.throws(() => adapter.storage.setItem(STORAGE_KEY, "latest run"), /could not enable saving/);
  assert.equal(adapter.storage.getItem(STORAGE_KEY), "latest run");
});
