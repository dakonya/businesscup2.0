"use client";

import { useEffect, useMemo, useState } from "react";
import type { RequestSummary, RunView } from "../lib/contracts";
import { dataLabel, dataValue, eventKind, eventMessage, formatCount, formatSeconds } from "../lib/client/locale-ru";
import { Icon } from "./icons";

type RequestFilter = "all" | RequestSummary["status"];
const PAGE_SIZE = 8;
const statusLabels: Record<RequestSummary["status"], string> = {
  succeeded: "Успешно", failed: "Ошибка", pending: "Ожидает",
};
const filters: Array<{ value: RequestFilter; label: string }> = [
  { value: "all", label: "Все" },
  { value: "failed", label: "Ошибки" },
  { value: "pending", label: "Ожидают" },
  { value: "succeeded", label: "Успешные" },
];

export function RequestExplorer({ view, selectedRequestId, onSelect, highlightEventId }: {
  view: RunView;
  selectedRequestId: string | null;
  onSelect: (id: string | null) => void;
  highlightEventId?: string | null;
}) {
  const [filter, setFilter] = useState<RequestFilter>("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);

  const counts = useMemo(() => {
    const result = { all: view.requests.length, succeeded: 0, failed: 0, pending: 0 };
    for (const request of view.requests) result[request.status]++;
    return result;
  }, [view.requests]);

  const filteredRequests = useMemo(() => {
    const search = query.trim().toLowerCase();
    return view.requests.filter(request => (filter === "all" || request.status === filter) && request.id.toLowerCase().includes(search));
  }, [view.requests, filter, query]);

  const pageCount = Math.max(1, Math.ceil(filteredRequests.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageRequests = filteredRequests.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const selected = useMemo(() => view.requests.find(request => request.id === selectedRequestId), [view.requests, selectedRequestId]);
  // Every linked event is retained. Only the request list is paginated.
  const selectedTrace = useMemo(() => selectedRequestId ? view.events.filter(event => event.requestId === selectedRequestId) : [], [view.events, selectedRequestId]);

  useEffect(() => {
    if (!highlightEventId) return;
    const target = document.getElementById(`evidence-${highlightEventId}`);
    target?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "nearest" });
  }, [highlightEventId, selectedRequestId]);

  const selectedVisible = selected && pageRequests.some(request => request.id === selected.id);

  return (
    <section className="explorer" aria-label="Запросы">
      <div className="explorer-toolbar">
        <div className="explorer-filters" role="group" aria-label="Фильтр запросов по результату">
          {filters.map(option => <button key={option.value} type="button" className={`explorer-filter${filter === option.value ? " is-active" : ""}`} aria-pressed={filter === option.value} onClick={() => { setFilter(option.value); setPage(0); }}>
            {option.label} <span>{formatCount(counts[option.value])}</span>
          </button>)}
        </div>
        <label className="explorer-search">
          <span className="explorer-search-label">Поиск запросов</span>
          <span className="explorer-search-field"><Icon name="search" size={16} /><input type="search" placeholder="ID запроса" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} /></span>
        </label>
      </div>

      <div className="explorer-table-scroll">
        <table className="explorer-table">
          <caption className="explorer-caption">Каждый запрос учтён один раз. Открой запрос, чтобы посмотреть все его события.</caption>
          <thead><tr><th scope="col">Запрос</th><th scope="col">Поступил</th><th scope="col">Результат</th><th scope="col">Попытки</th><th scope="col">Время ответа</th></tr></thead>
          <tbody>
            {pageRequests.map(request => {
              const expanded = request.id === selectedRequestId;
              return <tr key={request.id} className={expanded ? "explorer-row is-selected" : "explorer-row"}>
                <th scope="row"><button type="button" className="explorer-request-button" aria-expanded={expanded} aria-controls={expanded ? `request-trace-${request.id}` : undefined} onClick={() => onSelect(expanded ? null : request.id)}><Icon name={expanded ? "chevron" : "right"} size={15} /><code>{request.id}</code><span className="explorer-open-label">{expanded ? "Скрыть" : "Подробнее"}</span></button></th>
                <td><time>{formatSeconds(request.arrivedAtMs)}</time></td>
                <td><span className={`explorer-status explorer-status-${request.status}`}>{statusLabels[request.status]}</span></td>
                <td>{formatCount(request.attempts)}</td>
                <td>{request.latencyMs === null ? <span className="explorer-muted">{request.status === "pending" ? "Ожидание" : "Нет ответа"}</span> : `${formatCount(request.latencyMs)} мс`}</td>
              </tr>;
            })}
            {pageRequests.length === 0 && <tr><td colSpan={5}><div className="explorer-empty"><Icon name="search" size={22} /><p>{view.requests.length === 0 ? "Запросов пока нет. Запусти прогон, чтобы они появились." : "Ничего не нашлось. Попробуй другой ID или фильтр."}</p></div></td></tr>}
          </tbody>
        </table>
      </div>

      <div className="explorer-pagination">
        <span>{filteredRequests.length ? `${formatCount(currentPage * PAGE_SIZE + 1)}–${formatCount(Math.min((currentPage + 1) * PAGE_SIZE, filteredRequests.length))} из ${formatCount(filteredRequests.length)}` : "0 запросов"}</span>
        <div><button type="button" className="explorer-page-button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} aria-label="Предыдущая страница запросов">Назад</button><span>Страница {formatCount(currentPage + 1)} из {formatCount(pageCount)}</span><button type="button" className="explorer-page-button" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)} aria-label="Следующая страница запросов">Далее</button></div>
      </div>

      {selectedRequestId && <section id={`request-trace-${selectedRequestId}`} className="trace-panel" aria-label={`История событий запроса ${selectedRequestId}`}>
        <div className="trace-heading"><div><span className="trace-eyebrow">СОБЫТИЯ ЗАПРОСА</span><h3><code>{selectedRequestId}</code>{selected && <span className={`explorer-status explorer-status-${selected.status}`}>{statusLabels[selected.status]}</span>}</h3></div><button type="button" className="trace-close" onClick={() => onSelect(null)} aria-label="Закрыть историю запроса"><Icon name="close" size={18} /></button></div>
        {selected && <p className="trace-summary">Попыток обращения к БД: {formatCount(selected.attempts)} · Пришёл в {formatSeconds(selected.arrivedAtMs)} · Событий к {formatSeconds(view.atMs)}: {formatCount(selectedTrace.length)}{!selectedVisible ? ". В таблице запрос скрыт фильтром или находится на другой странице." : "."}</p>}
        <p className="trace-explainer">Повтор добавляет ещё одну попытку обращения к БД. При таймауте API перестаёт ждать ответ, но база данных может продолжать работу.</p>
        {selectedTrace.length ? <ol className="trace-events">{selectedTrace.map(event => <li key={event.id} id={`evidence-${event.id}`} className={`trace-event trace-event-${event.kind}${highlightEventId === event.id ? " is-highlighted" : ""}`}>
          <div className="trace-event-marker" aria-hidden="true" />
          <div className="trace-event-content"><div className="trace-event-meta"><time>{formatSeconds(event.atMs)}</time><span className="trace-event-kind">{eventKind(event.kind)}</span>{event.attemptId && <code className="trace-attempt">{event.attemptId}</code>}</div><p>{eventMessage(event)}</p>{event.data && Object.keys(event.data).length > 0 && <dl className="trace-event-data">{Object.entries(event.data).map(([key, value]) => <div key={key}><dt>{dataLabel(key)}</dt><dd>{dataValue(key, value)}</dd></div>)}</dl>}</div>
        </li>)}</ol> : <div className="trace-empty"><p>{selected ? "У этого запроса пока нет событий." : "В этот момент запроса ещё нет. Продвинь время или выбери другой запрос."}</p></div>}
      </section>}
    </section>
  );
}
