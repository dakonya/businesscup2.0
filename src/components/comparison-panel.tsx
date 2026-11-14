"use client";

import type { ComparisonView, RunMetrics } from "../lib/contracts";
import { Icon } from "./icons";

const count = (value: number) => value.toLocaleString("en-US");
const seconds = (value: number) => `${Number((value / 1000).toFixed(1))}s`;
const signed = (value: number) => value === 0 ? "No change" : `${value > 0 ? "+" : "−"}${count(Math.abs(value))}`;
const latency = (value: number | null) => value === null ? "—" : `${count(Math.round(value))} ms`;

const outcomes = [
  { key: "succeeded", label: "Successful", color: "#14825E" },
  { key: "failed", label: "Failed", color: "#D64550" },
  { key: "pending", label: "Pending", color: "#B7780D" },
] as const;

function OutcomeBars({ left, right, leftLabel, rightLabel }: {
  left: RunMetrics;
  right: RunMetrics;
  leftLabel: string;
  rightLabel: string;
}) {
  const maximum = Math.max(1, left.arrived, right.arrived);
  const start = 112;
  const barWidth = 580;
  const bars = [{ metrics: left, label: leftLabel }, { metrics: right, label: rightLabel }];
  return <figure className="compare-outcomes">
    <svg className="compare-outcomes-svg" viewBox="0 0 740 136" role="img" aria-label={`${leftLabel}: ${count(left.succeeded)} successful, ${count(left.failed)} failed, ${count(left.pending)} pending. ${rightLabel}: ${count(right.succeeded)} successful, ${count(right.failed)} failed, ${count(right.pending)} pending. Both bars use the same customer count scale.`}>
      <text x={start} y="17" fill="#69758B" fontSize="11">UNIQUE USER REQUESTS · SAME SCALE</text>
      {bars.map(({ metrics, label }, index) => {
        const y = 34 + index * 46;
        let offset = 0;
        return <g key={index}>
          <text x="0" y={y + 21} fill="#38455D" fontSize="13" fontWeight="600">{label.length > 15 ? `${label.slice(0, 14)}…` : label}</text>
          <rect x={start} y={y} width={barWidth} height="31" rx="4" fill="#EDF1F7" />
          {outcomes.map(outcome => {
            const value = metrics[outcome.key];
            const width = (value / maximum) * barWidth;
            const x = start + offset;
            offset += width;
            return <g key={outcome.key}>
              <rect x={x} y={y} width={width} height="31" fill={outcome.color} />
              {width > 40 && <text x={x + width / 2} y={y + 20} fill="white" textAnchor="middle" fontSize="12" fontWeight="600">{count(value)}</text>}
            </g>;
          })}
          <text x="704" y={y + 21} fill="#69758B" fontSize="12">{count(metrics.arrived)}</text>
        </g>;
      })}
    </svg>
    <figcaption className="compare-legend">{outcomes.map(outcome => <span key={outcome.key}><i style={{ backgroundColor: outcome.color }} aria-hidden="true" />{outcome.label}</span>)}</figcaption>
  </figure>;
}

export function ComparisonPanel({ comparison, leftLabel, rightLabel, onClose, onDebrief }: {
  comparison: ComparisonView;
  leftLabel: string;
  rightLabel: string;
  onClose: () => void;
  onDebrief: () => void;
}) {
  const { left, right, delta, untilMs } = comparison;
  const rows = [
    { name: "Successful requests", left: count(left.metrics.succeeded), right: count(right.metrics.succeeded), change: signed(delta.succeeded), tone: delta.succeeded > 0 ? "good" : delta.succeeded < 0 ? "risk" : "neutral" },
    { name: "Failed requests", left: count(left.metrics.failed), right: count(right.metrics.failed), change: signed(delta.failed), tone: delta.failed < 0 ? "good" : delta.failed > 0 ? "risk" : "neutral" },
    { name: "Pending requests", left: count(left.metrics.pending), right: count(right.metrics.pending), change: signed(right.metrics.pending - left.metrics.pending), tone: "neutral" },
    { name: "Database attempts", left: count(left.metrics.totalAttempts), right: count(right.metrics.totalAttempts), change: signed(delta.totalAttempts), tone: "neutral" },
    { name: "Retries", left: count(left.metrics.retries), right: count(right.metrics.retries), change: signed(right.metrics.retries - left.metrics.retries), tone: "neutral" },
    {
      name: "p95 latency · successful only",
      left: latency(left.metrics.p95LatencyMs),
      right: latency(right.metrics.p95LatencyMs),
      change: left.metrics.p95LatencyMs === null || right.metrics.p95LatencyMs === null
        ? "Not comparable"
        : right.metrics.p95LatencyMs === left.metrics.p95LatencyMs
          ? "No change"
          : `${signed(Math.round(right.metrics.p95LatencyMs - left.metrics.p95LatencyMs))} ms`,
      tone: "neutral",
    },
  ];
  const successDifference = delta.succeeded === 0
    ? "the same number of successful responses"
    : `${count(Math.abs(delta.succeeded))} ${delta.succeeded > 0 ? "more" : "fewer"} successful responses`;

  return <section className="compare-panel" aria-labelledby="compare-heading">
    <div className="compare-heading-row">
      <div>
        <p className="compare-eyebrow">SAME TRAFFIC. DIFFERENT DECISIONS.</p>
        <h2 id="compare-heading">Compare the consequences</h2>
        <p className="compare-subtitle">Both attempts replayed to {seconds(untilMs)} with the same scenario and seed.</p>
      </div>
      <button type="button" className="compare-close" onClick={onClose} aria-label="Close comparison"><Icon name="close" size={20} /></button>
    </div>

    <div className="compare-context">
      <span><Icon name="activity" size={15} />{left.scenarioId}</span>
      <span>Seed {count(left.seed)}</span>
      <span><Icon name="clock" size={15} />Horizon {seconds(untilMs)}</span>
    </div>

    <OutcomeBars left={left.metrics} right={right.metrics} leftLabel={leftLabel} rightLabel={rightLabel} />

    <div className="compare-table-scroll" tabIndex={0} role="region" aria-label="Attempt comparison results, scroll horizontally on small screens">
      <table className="compare-table">
        <caption className="compare-table-caption">Changes are {rightLabel} minus {leftLabel}. Pending customers are still waiting; they are not failed requests.</caption>
        <thead><tr><th scope="col">Metric</th><th scope="col">{leftLabel}</th><th scope="col">{rightLabel}</th><th scope="col">Change</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.name}><th scope="row">{row.name}</th><td>{row.left}</td><td>{row.right}</td><td className={`compare-change compare-change-${row.tone}`}>{row.change}</td></tr>)}</tbody>
      </table>
    </div>

    <div className="compare-takeaway">
      <span className="compare-takeaway-icon"><Icon name="chart" size={20} /></span>
      <div><strong>{rightLabel} produced {successDifference}.</strong><p>At this horizon it still has {count(right.metrics.failed)} failed and {count(right.metrics.pending)} pending requests. Read these together with database attempts; fewer attempts alone do not establish a better outcome.</p></div>
    </div>

    <div className="compare-footer">
      <p>Simulated outcomes from this case. Successful-only latency does not describe customers who failed or are still waiting.</p>
      <button type="button" className="btn btn-primary compare-debrief" onClick={onDebrief}><Icon name="sparkles" size={18} />Get comparison debrief<Icon name="arrow" size={17} /></button>
    </div>
  </section>;
}
