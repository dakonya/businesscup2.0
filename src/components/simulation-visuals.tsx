import type { RunMetrics, TimePoint } from "../lib/contracts";
import { formatCount, formatSeconds } from "../lib/client/locale-ru";
import { Icon } from "./icons";

const clamp = (value: number, lower: number, upper: number) => Math.min(upper, Math.max(lower, value));

const chartLines = [
  { key: "succeeded", label: "Успешные", color: "#14825E" },
  { key: "failed", label: "С ошибкой", color: "#D64550" },
  { key: "pending", label: "В ожидании", color: "#B7780D" },
  { key: "totalAttempts", label: "Попытки обращения к БД", color: "#315FE8" },
] as const;

export function RequestChart({ series, durationMs, checkpointMs, cursorMs }: {
  series: TimePoint[];
  durationMs: number;
  checkpointMs: number;
  cursorMs: number;
}) {
  if (!series.length) return <div className="viz-chart-empty"><Icon name="chart" size={28} /><p>Запустите симуляцию, чтобы увидеть результаты запросов во времени.</p></div>;

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
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Рассчитанные результаты запросов и попытки обращения к БД: ${formatSeconds(cursorMs)} из ${formatSeconds(durationMs)}. Данные текущей симуляции.`} className="viz-chart-svg">
          <text x={left} y="17" className="viz-axis-title" fill="#69758B" fontSize="11">КОЛИЧЕСТВО</text>
          {[0, 1, 2, 3, 4].map(index => {
            const value = (yMaximum / 4) * index;
            return <g key={index}><line x1={left} x2={width - right} y1={y(value)} y2={y(value)} stroke="#E8EDF5" /><text x={left - 12} y={y(value) + 4} textAnchor="end" fill="#6C7890" fontSize="12">{formatCount(Math.round(value))}</text></g>;
          })}
          {[0, 1, 2, 3, 4].map(index => {
            const atMs = (durationMs / 4) * index;
            return <text key={index} x={x(atMs)} y={height - 16} textAnchor="middle" fill="#6C7890" fontSize="12">{formatSeconds(atMs)}</text>;
          })}
          <line x1={checkpointX} x2={checkpointX} y1={top} y2={height - bottom} stroke="#A3ADC0" strokeDasharray="3 5" />
          <text x={clamp(checkpointX + 6, left, width - right - 120)} y={top - 10} fill="#7C879B" fontSize="11">Точка возврата</text>
          {chartLines.map(line => <g key={line.key}>
            <path d={series.map((point, index) => `${index === 0 ? "M" : "L"}${x(point.atMs).toFixed(2)},${y(point[line.key]).toFixed(2)}`).join(" ")} fill="none" stroke={line.color} strokeWidth="2.5" strokeDasharray={line.key === "totalAttempts" ? "7 4" : undefined} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            {series.length === 1 && <circle cx={x(series[0].atMs)} cy={y(series[0][line.key])} r="3" fill={line.color} />}
          </g>)}
          <line x1={cursorX} x2={cursorX} y1={top} y2={height - bottom} stroke="#315FE8" strokeWidth="1" opacity=".3" />
        </svg>
      </div>
      <figcaption>
        <div className="viz-chart-legend">{chartLines.map(line => <span key={line.key}><i style={{ backgroundColor: line.color }} className={line.key === "totalAttempts" ? "viz-key-dashed" : undefined} aria-hidden="true" />{line.label}</span>)}</div>
        <p className="viz-chart-note">Успешные, с ошибкой и ожидающие — уникальные запросы. Повтор добавляет ещё одну попытку обращения к БД.</p>
      </figcaption>
    </figure>
  );
}

export function Topology({ metrics }: { metrics: RunMetrics }) {
  return (
    <div className="viz-topology" role="group" aria-label="Путь запроса в симуляции: API, очередь и обработчики, база данных">
      <div className="viz-node viz-node-api">
        <span className="viz-node-icon"><Icon name="server" size={22} /></span>
        <div className="viz-node-copy"><strong>API</strong><span>Принимает запросы</span></div>
        <div className="viz-node-stat"><b>{formatCount(metrics.apiQueue)}</b><span>ожидают на API</span></div>
      </div>
      <div className="viz-connector" aria-hidden="true"><span /><Icon name="arrow" size={19} /></div>
      <div className="viz-node viz-node-queue">
        <span className="viz-node-icon"><Icon name="activity" size={22} /></span>
        <div className="viz-node-copy"><strong>Очередь / обработчики</strong><span>Очередь — ожидающая работа</span></div>
        <div className="viz-node-stat"><b>{formatCount(metrics.dbQueue)}</b><span>ожидают базу данных</span></div>
      </div>
      <div className="viz-connector" aria-hidden="true"><span /><Icon name="arrow" size={19} /></div>
      <div className="viz-node viz-node-database">
        <span className="viz-node-icon"><Icon name="database" size={22} /></span>
        <div className="viz-node-copy"><strong>База данных</strong><span>Обрабатывает попытки</span></div>
        <div className="viz-node-stat"><b>{formatCount(metrics.dbActive)}</b><span>активные операции</span></div>
      </div>
      <div className="viz-topology-caption"><span className="viz-live-dot" aria-hidden="true" />Рассчитано для этой попытки <span className="viz-caption-divider">·</span> Обращений к БД: {formatCount(metrics.totalAttempts)}</div>
    </div>
  );
}
