import type { ScenarioDefinition, RunSpec, RunView, ComparisonView } from "../contracts";
export class EngineNotReadyError extends Error { constructor() { super("Simulation engine is not ready yet."); this.name = "EngineNotReadyError"; } }
export function getScenarios(): ScenarioDefinition[] { throw new EngineNotReadyError(); }
export function simulateRun(_spec: RunSpec, _untilMs: number): RunView { throw new EngineNotReadyError(); }
export function compareRuns(_left: RunSpec, _right: RunSpec, _untilMs: number): ComparisonView { throw new EngineNotReadyError(); }
