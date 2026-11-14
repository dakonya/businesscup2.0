import type { RunMetrics, TimePoint } from "../lib/contracts";
import { Icon } from "./icons";

const formatCount = (value: number) => value.toLocaleString("en-US");
const formatSeconds = (value: number) => `${Number((value / 1000).toFixed(1))}s`;
const clamp = (value: number, lower: number, upper: number) => Math.min(upper, Math.max(lower, value));

const chartLines = [
  { key: "succeeded", label: "Successful", color: "#14825E" },
  { key: "failed", label: "Failed", color: "#D64550" },
  { key: "pending", label: "Pending", color: "#B7780D" },
  { key: "totalAttempts", label: "Database attempts", color: "#315FE8" },
] as const;

export function RequestChart({ series, durationMs, checkpointMs, cursorMs }: {
  series: TimePoint[];
  durationMs: number;
  checkpointMs: number;
  cursorMs: number;
}) {
  if (!series.length) return <div className="viz-chart-empty"><Icon name="chart" size={28} /><p>Run the simulation to see request outcomes over time.</p></div>;

  const width = 760;
  const height = 270;
  const left = 55;
  const right = 23;
  const top = 32;
  const bottom = 43;
  const graphWidth = width - left - right;
  const graphHeight = height - top - bottom;
  const maximum = Math.max(1, ...series.flatMap(point => chartLines.map(line => point[line.key])));
  const magnitude = 10 ** Math.floor(Math.log10(maximum));
  const yMaximum = Math.ceil(maximum / magnitude) * magnitude;
  const x = (atMs: number) => left + (clamp(atMs, 0, durationMs) / Math.max(1, durationMs)) * graphWidth;
  const y = (value: number) => top + graphHeight - (value / yMaximum) * graphHeight;
  const checkpointX = x(checkpointMs);
  const cursorX = x(cursorMs);

  return (
    <figure className="viz-chart">
      <div className="viz-chart-scroll">
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Computed request outcomes and database attempts through ${formatSeconds(cursorMs)} of ${formatSeconds(durationMs)}. Data comes from the current simulation run.`} className="viz-chart-svg">
          <text x={left} y="17" className="viz-axis-title" fill="#69758B" fontSize="11">COUNT</text>
          {[0, 1, 2, 3, 4].map(index => {
            const value = (yMaximum / 4) * index;
            return <g key={index}><line x1={left} x2={width - right} y1={y(value)} y2={y(value)} stroke="#E8EDF5" /><text x={left - 12} y={y(value) + 4} textAnchor="end" fill="#6C7890" fontSize="12">{formatCount(Math.round(value))}</text></g>;
          })}
          {[0, 1, 2, 3, 4].map(index => {
            const atMs = (durationMs / 4) * index;
            return <text key={index} x={x(atMs)} y={height - 16} textAnchor="middle" fill="#6C7890" fontSize="12">{formatSeconds(atMs)}</text>;
          })}
          <line x1={checkpointX} x2={checkpointX} y1={top} y2={height - bottom} stroke="#A3ADC0" strokeDasharray="3 5" />
          <text x={clamp(checkpointX + 6, left, width - right - 86)} y={top - 10} fill="#7C879B" fontSize="11">Checkpoint</text>
          {chartLines.map(line => <g key={line.key}>
            <path d={series.map((point, index) => `${index === 0 ? "M" : "L"}${x(point.atMs).toFixed(2)},${y(point[line.key]).toFixed(2)}`).join(" ")} fill="none" stroke={line.color} strokeWidth="2.5" strokeDasharray={line.key === "totalAttempts" ? "7 4" : undefined} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            {series.length === 1 && <circle cx={x(series[0].atMs)} cy={y(series[0][line.key])} r="3" fill={line.color} />}
          </g>)}
          <line x1={cursorX} x2={cursorX} y1={top} y2={height - bottom} stroke="#315FE8" strokeWidth="1" opacity=".3" />
        </svg>
      </div>
      <figcaption>
        <div className="viz-chart-legend">{chartLines.map(line => <span key={line.key}><i style={{ backgroundColor: line.color }} className={line.key === "totalAttempts" ? "viz-key-dashed" : undefined} aria-hidden="true" />{line.label}</span>)}</div>
        <p className="viz-chart-note">Successful, failed and pending count unique requests. A retry adds another database attempt.</p>
      </figcaption>
    </figure>
  );
}

export function Topology({ metrics }: { metrics: RunMetrics }) {
  return (
    <div className="viz-topology" role="group" aria-label="Simulated request path: API, waiting work, database">
      <div className="viz-node viz-node-api">
        <span className="viz-node-icon"><Icon name="server" size={22} /></span>
        <div className="viz-node-copy"><strong>API</strong><span>Accepts user requests</span></div>
        <div className="viz-node-stat"><b>{formatCount(metrics.apiQueue)}</b><span>waiting at API</span></div>
      </div>
      <div className="viz-connector" aria-hidden="true"><span /><Icon name="arrow" size={19} /></div>
      <div className="viz-node viz-node-queue">
        <span className="viz-node-icon"><Icon name="activity" size={22} /></span>
        <div className="viz-node-copy"><strong>Queue / workers</strong><span>Queue means waiting work</span></div>
        <div className="viz-node-stat"><b>{formatCount(metrics.dbQueue)}</b><span>waiting for database</span></div>
      </div>
      <div className="viz-connector" aria-hidden="true"><span /><Icon name="arrow" size={19} /></div>
      <div className="viz-node viz-node-database">
        <span className="viz-node-icon"><Icon name="database" size={22} /></span>
        <div className="viz-node-copy"><strong>Database</strong><span>Processes attempts</span></div>
        <div className="viz-node-stat"><b>{formatCount(metrics.dbActive)}</b><span>active operations</span></div>
      </div>
      <div className="viz-topology-caption"><span className="viz-live-dot" aria-hidden="true" />Computed from this run <span className="viz-caption-divider">·</span> {formatCount(metrics.totalAttempts)} database attempts so far</div>
    </div>
  );
}
