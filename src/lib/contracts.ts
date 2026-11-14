// IncidentLab handoff v1. Copy to src/lib/contracts.ts during bootstrap.
// Types only: no secrets, server imports, runtime dependencies, or simulated results.
export type ScenarioId = "catalog-slowdown";
export interface Controls {
  apiReplicas: number;
  maxAttempts: number; // Total attempts, including the first.
  retryBackoffMs: number;
}
export type Intervention =
  | { atMs: number; type: "set-api-replicas"; value: number }
  | { atMs: number; type: "set-max-attempts"; value: number }
  | { atMs: number; type: "set-retry-backoff"; value: number };
export interface RunSpec {
  schemaVersion: 1;
  scenarioId: ScenarioId;
  seed: number;
  actions: Intervention[]; // Nondecreasing atMs; array order resolves equal timestamps.
}
export interface ScenarioDefinition {
  id: ScenarioId;
  title: string;
  briefing: string;
  learningGoals: string[];
  durationMs: number;
  checkpointMs: number;
  defaultControls: Controls;
  controls: Array<{
    type: Intervention["type"];
    label: string;
    description: string;
    values: number[];
  }>;
}
export interface RunMetrics {
  arrived: number;
  succeeded: number;
  failed: number;
  pending: number;
  totalAttempts: number;
  retries: number;
  apiQueue: number;
  dbQueue: number;
  dbActive: number;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
}
export interface TimePoint {
  atMs: number;
  succeeded: number;
  failed: number;
  pending: number;
  totalAttempts: number;
  apiQueue: number;
  dbQueue: number;
}
export interface TraceEvent {
  id: string;
  atMs: number;
  kind: string;
  message: string;
  requestId?: string;
  attemptId?: string;
  data?: Record<string, string | number | boolean>;
}
export interface RequestSummary {
  id: string;
  arrivedAtMs: number;
  status: "pending" | "succeeded" | "failed";
  attempts: number;
  latencyMs: number | null;
}
export interface RunView {
  schemaVersion: 1;
  scenarioId: ScenarioId;
  seed: number;
  atMs: number;
  finished: boolean;
  controls: Controls;
  metrics: RunMetrics;
  series: TimePoint[];
  events: TraceEvent[];
  requests: RequestSummary[];
}
export interface ComparisonView {
  untilMs: number;
  left: RunView;
  right: RunView;
  delta: {
    succeeded: number;
    failed: number;
    totalAttempts: number;
  }; // Every delta is right minus left.
}
export interface SavedAttempt {
  id: string;
  label: string;
  spec: RunSpec;
  cursorMs: number;
}
export interface SavedSession {
  schemaVersion: 1;
  activeAttemptId: string;
  attempts: SavedAttempt[];
}
export interface CoachRequest {
  mode: "hint" | "debrief";
  primary: RunSpec;
  comparison?: RunSpec;
  untilMs: number;
  hintLevel?: 1 | 2 | 3;
}
export interface CoachResponse {
  source: "nvidia" | "rules";
  summary: string;
  observations: Array<{ text: string; evidenceEventIds: string[] }>;
  nextExperiment: string;
  limitations: string[];
  warning?: string;
}
export interface ApiError {
  error: { code: string; message: string };
}
export interface HealthResponse {
  status: "ok";
  contractVersion: 1;
  coachConfigured: boolean; // Configuration presence, not proven provider health.
}
