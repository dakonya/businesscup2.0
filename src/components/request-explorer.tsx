"use client";

import { useEffect, useMemo, useState } from "react";
import type { RequestSummary, RunView } from "../lib/contracts";
import { Icon } from "./icons";

type RequestFilter = "all" | RequestSummary["status"];
const PAGE_SIZE = 8;
const statusLabels: Record<RequestSummary["status"], string> = {
  succeeded: "Successful", failed: "Failed", pending: "Pending",
};
const filters: Array<{ value: RequestFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "failed", label: "Failed" },
  { value: "pending", label: "Pending" },
  { value: "succeeded", label: "Successful" },
];

function seconds(ms: number) {
  return `${(ms / 1000).toFixed(3)}s`;
}

function humanize(value: string) {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]/g, " ").replace(/^./, first => first.toUpperCase()).replace(/\bdb\b/gi, "DB").replace(/\bapi\b/gi, "API");
}

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
    <section className="explorer" aria-label="Request explorer">
      <div className="explorer-toolbar">
        <div className="explorer-filters" role="group" aria-label="Filter requests by outcome">
          {filters.map(option => <button key={option.value} type="button" className={`explorer-filter${filter === option.value ? " is-active" : ""}`} aria-pressed={filter === option.value} onClick={() => { setFilter(option.value); setPage(0); }}>
            {option.label} <span>{counts[option.value].toLocaleString("en-US")}</span>
          </button>)}
        </div>
        <label className="explorer-search">
          <span className="explorer-search-label">Search requests</span>
          <span className="explorer-search-field"><Icon name="search" size={16} /><input type="search" placeholder="Request ID" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} /></span>
        </label>
      </div>

      <div className="explorer-table-scroll">
        <table className="explorer-table">
          <caption className="explorer-caption">Unique user requests. Open a request to inspect its complete evidence trail.</caption>
          <thead><tr><th scope="col">Request</th><th scope="col">Arrived</th><th scope="col">Outcome</th><th scope="col">Attempts</th><th scope="col">Response time</th></tr></thead>
          <tbody>
            {pageRequests.map(request => {
              const expanded = request.id === selectedRequestId;
              return <tr key={request.id} className={expanded ? "explorer-row is-selected" : "explorer-row"}>
                <th scope="row"><button type="button" className="explorer-request-button" aria-expanded={expanded} aria-controls={expanded ? `request-trace-${request.id}` : undefined} onClick={() => onSelect(expanded ? null : request.id)}><Icon name={expanded ? "chevron" : "right"} size={15} /><code>{request.id}</code><span className="explorer-open-label">{expanded ? "Close trace" : "Inspect"}</span></button></th>
                <td><time>{seconds(request.arrivedAtMs)}</time></td>
                <td><span className={`explorer-status explorer-status-${request.status}`}>{statusLabels[request.status]}</span></td>
                <td>{request.attempts.toLocaleString("en-US")}</td>
                <td>{request.latencyMs === null ? <span className="explorer-muted">{request.status === "pending" ? "Waiting" : "No response"}</span> : `${request.latencyMs.toLocaleString("en-US")} ms`}</td>
              </tr>;
            })}
            {pageRequests.length === 0 && <tr><td colSpan={5}><div className="explorer-empty"><Icon name="search" size={22} /><p>{view.requests.length === 0 ? "No requests have arrived yet. Advance model time to inspect one." : "No requests match this filter. Try another outcome or request ID."}</p></div></td></tr>}
          </tbody>
        </table>
      </div>

      <div className="explorer-pagination">
        <span>{filteredRequests.length ? `${currentPage * PAGE_SIZE + 1}–${Math.min((currentPage + 1) * PAGE_SIZE, filteredRequests.length)} of ${filteredRequests.length.toLocaleString("en-US")}` : "0 requests"}</span>
        <div><button type="button" className="explorer-page-button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} aria-label="Previous page of requests">Previous</button><span>Page {currentPage + 1} of {pageCount}</span><button type="button" className="explorer-page-button" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)} aria-label="Next page of requests">Next</button></div>
      </div>

      {selectedRequestId && <section id={`request-trace-${selectedRequestId}`} className="trace-panel" aria-label={`Evidence trail for request ${selectedRequestId}`}>
        <div className="trace-heading"><div><span className="trace-eyebrow">REQUEST EVIDENCE</span><h3><code>{selectedRequestId}</code>{selected && <span className={`explorer-status explorer-status-${selected.status}`}>{statusLabels[selected.status]}</span>}</h3></div><button type="button" className="trace-close" onClick={() => onSelect(null)} aria-label="Close request evidence"><Icon name="close" size={18} /></button></div>
        {selected && <p className="trace-summary">{selected.attempts} database {selected.attempts === 1 ? "attempt" : "attempts"} · Arrived at {seconds(selected.arrivedAtMs)} · {selectedTrace.length} evidence events through {seconds(view.atMs)}{!selectedVisible ? ". Selected request is outside the current table page or filter." : "."}</p>}
        <p className="trace-explainer">A retry adds another attempt. A timeout means the API stopped waiting; database work may still finish later.</p>
        {selectedTrace.length ? <ol className="trace-events">{selectedTrace.map(event => <li key={event.id} id={`evidence-${event.id}`} className={`trace-event trace-event-${event.kind}${highlightEventId === event.id ? " is-highlighted" : ""}`}>
          <div className="trace-event-marker" aria-hidden="true" />
          <div className="trace-event-content"><div className="trace-event-meta"><time>{seconds(event.atMs)}</time><span className="trace-event-kind">{humanize(event.kind)}</span>{event.attemptId && <code className="trace-attempt">{event.attemptId}</code>}</div><p>{event.message}</p>{event.data && Object.keys(event.data).length > 0 && <dl className="trace-event-data">{Object.entries(event.data).map(([key, value]) => <div key={key}><dt>{humanize(key)}</dt><dd>{String(value)}</dd></div>)}</dl>}</div>
        </li>)}</ol> : <div className="trace-empty"><p>{selected ? "No evidence events exist for this request at the current model time." : "This request is not present at the current model time. Advance time or select another request."}</p></div>}
      </section>}
    </section>
  );
}
