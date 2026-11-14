"use client";

import type { ComparisonView, RunMetrics } from "../lib/contracts";
import { Icon } from "./icons";

const count = (value: number) => value.toLocaleString("ru-RU");
const seconds = (value: number) => `${(value / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} с`;
const signed = (value: number) => value === 0 ? "Без изменений" : `${value > 0 ? "+" : "−"}${count(Math.abs(value))}`;
const latency = (value: number | null) => value === null ? "—" : `${count(Math.round(value))} мс`;

const outcomes = [
  { key: "succeeded", label: "Успешно", color: "#14825E" },
  { key: "failed", label: "С ошибкой", color: "#D64550" },
  { key: "pending", label: "В ожидании", color: "#B7780D" },
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
    <svg className="compare-outcomes-svg" viewBox="0 0 740 136" role="img" aria-label={`${leftLabel}: успешно — ${count(left.succeeded)}, с ошибкой — ${count(left.failed)}, в ожидании — ${count(left.pending)}. ${rightLabel}: успешно — ${count(right.succeeded)}, с ошибкой — ${count(right.failed)}, в ожидании — ${count(right.pending)}. Каждый запрос пользователя посчитан один раз. Обе полосы в одной шкале.`}>
      <text x={start} y="17" fill="#69758B" fontSize="11">ЗАПРОСЫ ПОЛЬЗОВАТЕЛЕЙ · ОБЩАЯ ШКАЛА</text>
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
    { name: "Успешные запросы", left: count(left.metrics.succeeded), right: count(right.metrics.succeeded), change: signed(delta.succeeded), tone: delta.succeeded > 0 ? "good" : delta.succeeded < 0 ? "risk" : "neutral" },
    { name: "Запросы с ошибкой", left: count(left.metrics.failed), right: count(right.metrics.failed), change: signed(delta.failed), tone: delta.failed < 0 ? "good" : delta.failed > 0 ? "risk" : "neutral" },
    { name: "Запросы в ожидании", left: count(left.metrics.pending), right: count(right.metrics.pending), change: signed(right.metrics.pending - left.metrics.pending), tone: "neutral" },
    { name: "Попытки обращения к БД", left: count(left.metrics.totalAttempts), right: count(right.metrics.totalAttempts), change: signed(delta.totalAttempts), tone: "neutral" },
    { name: "Повторные попытки", left: count(left.metrics.retries), right: count(right.metrics.retries), change: signed(right.metrics.retries - left.metrics.retries), tone: "neutral" },
    {
      name: "Время ответа p95 · только успешные",
      left: latency(left.metrics.p95LatencyMs),
      right: latency(right.metrics.p95LatencyMs),
      change: left.metrics.p95LatencyMs === null || right.metrics.p95LatencyMs === null
        ? "Нельзя сравнить"
        : right.metrics.p95LatencyMs === left.metrics.p95LatencyMs
          ? "Без изменений"
          : `${signed(Math.round(right.metrics.p95LatencyMs - left.metrics.p95LatencyMs))} мс`,
      tone: "neutral",
    },
  ];
  const successDifference = delta.succeeded === 0
    ? "число успешных ответов не изменилось"
    : `успешных ответов на ${count(Math.abs(delta.succeeded))} ${delta.succeeded > 0 ? "больше" : "меньше"}`;

  return <section className="compare-panel" aria-labelledby="compare-heading">
    <div className="compare-heading-row">
      <div>
        <p className="compare-eyebrow">ОДИНАКОВЫЙ ПОТОК ЗАПРОСОВ</p>
        <h2 id="compare-heading">Сравнение попыток</h2>
        <p className="compare-subtitle">Обе попытки прошли один и тот же сценарий до отметки {seconds(untilMs)}.</p>
      </div>
      <button type="button" className="compare-close" onClick={onClose} aria-label="Закрыть сравнение"><Icon name="close" size={20} /></button>
    </div>

    <div className="compare-context">
      <span><Icon name="activity" size={15} />Замедление каталога</span>
      <span>Сид {count(left.seed)}</span>
      <span><Icon name="clock" size={15} />До {seconds(untilMs)}</span>
    </div>

    <OutcomeBars left={left.metrics} right={right.metrics} leftLabel={leftLabel} rightLabel={rightLabel} />

    <div className="compare-table-scroll" tabIndex={0} role="region" aria-label="Таблица сравнения попыток. Если она не помещается, прокрути вбок">
      <table className="compare-table">
        <caption className="compare-table-caption">Разница: «{rightLabel}» минус «{leftLabel}». В ожидании — запросы, для которых ещё нет результата.</caption>
        <thead><tr><th scope="col">Показатель</th><th scope="col">{leftLabel}</th><th scope="col">{rightLabel}</th><th scope="col">Изменение</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.name}><th scope="row">{row.name}</th><td>{row.left}</td><td>{row.right}</td><td className={`compare-change compare-change-${row.tone}`}>{row.change}</td></tr>)}</tbody>
      </table>
    </div>

    <div className="compare-takeaway">
      <span className="compare-takeaway-icon"><Icon name="chart" size={20} /></span>
      <div><strong>{rightLabel}: {successDifference}.</strong><p>Запросы с ошибкой: {count(right.metrics.failed)}; ещё ждут ответа: {count(right.metrics.pending)}. Сначала сравни успешные ответы, ошибки и ожидание, затем число обращений к БД.</p></div>
    </div>

    <div className="compare-footer">
      <p>Время ответа здесь посчитано только для успешных запросов. Ошибки и ожидание смотри отдельно.</p>
      <button type="button" className="btn btn-primary compare-debrief" onClick={onDebrief}><Icon name="sparkles" size={18} />Разобрать сравнение<Icon name="arrow" size={17} /></button>
    </div>
  </section>;
}
