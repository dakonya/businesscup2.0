import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { expect, it } from "vitest";
import { simulateRun } from "../../src/lib/sim";
import type { RunSpec, RunView } from "../../src/lib/contracts";

it("bundles for browsers and produces the same replay without process, require, or server environment", async () => {
  // Vite is Vitest's installed peer. Build an actual browser bundle, then execute
  // it with standard browser-compatible globals and no Node runtime capabilities.
  const built = await build({
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      minify: false,
      lib: {
        entry: fileURLToPath(new URL("../../src/lib/sim/index.ts", import.meta.url)),
        formats: ["iife"],
        name: "IncidentLabEngine",
      },
    },
  });
  const bundle = Array.isArray(built) ? built[0] : built;
  if (!("output" in bundle)) throw new Error("Expected a completed browser build.");
  const javascript = bundle.output.filter(file => file.type === "chunk").map(file => file.code).join("\n");
  const spec: RunSpec = { schemaVersion: 1, scenarioId: "catalog-slowdown", seed: 42, actions: [] };
  const browserView = runInNewContext(
    `${javascript}\nIncidentLabEngine.simulateRun(spec, 25000);`,
    { structuredClone, spec },
    { timeout: 5_000 },
  ) as RunView;
  expect(JSON.parse(JSON.stringify(browserView))).toEqual(simulateRun(spec, 25_000));
});
