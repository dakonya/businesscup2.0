"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CoachRequest, Intervention, SavedAttempt, SavedSession } from "@/lib/contracts";
import { compareRuns, getScenarios, simulateRun, validateRunSpec } from "@/lib/sim";
import { appendIntervention, CONTROL_KEYS, createAttempt, forkAttempt, readSession, writeSession } from "@/lib/client/session";
import { openTabStorage } from "@/lib/client/tab-storage";
import { useCoach } from "@/lib/client/use-coach";
import { attemptLabel, dataLabel, dataValue, errorMessage, eventKind, eventMessage, formatCount as count, formatSeconds as seconds, localizeScenario } from "@/lib/client/locale-ru";
import { Icon, IncidentLogo } from "./icons";
import { RequestChart, Topology } from "./simulation-visuals";
import { RequestExplorer } from "./request-explorer";
import { ComparisonPanel } from "./comparison-panel";

const scenarios = getScenarios();
const scenario = localizeScenario(scenarios[0]);
const time = (ms: number) => `${Math.floor(ms / 60000).toString().padStart(2, "0")}:${Math.floor(ms % 60000 / 1000).toString().padStart(2, "0")}`;
const latency = (ms: number | null) => ms === null ? "—" : `${Math.round(ms)} мс`;
type Selection = { leftId: string; rightId: string; untilMs: number };

export default function IncidentLab() {
  const [session, setSession] = useState<SavedSession | null>(null);
  const sessionRef = useRef<SavedSession | null>(null);
  const storageRef = useRef<Pick<Storage, "getItem" | "setItem"> | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [started, setStarted] = useState(false);
  const [playing, setPlaying] = useState(false);
  const playingRef = useRef(false);
  const [speed, setSpeed] = useState(4);
  const [notice, setNotice] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [highlightEventId, setHighlightEventId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [coachMode, setCoachMode] = useState<"hint" | "debrief">("hint");
  const [hintLevel, setHintLevel] = useState<1 | 2 | 3>(1);
  const [helpOpen, setHelpOpen] = useState(false);
  const [debriefPending, setDebriefPending] = useState(false);
  const rewindGuard = useRef(false);
  const highWater = useRef<Record<string, number>>(Object.create(null));

  const commit = useCallback((next: SavedSession) => {
    for (const attempt of next.attempts) highWater.current[attempt.id] = Math.max(highWater.current[attempt.id] ?? 0, attempt.cursorMs);
    try { window.sessionStorage.setItem("incidentlab.viewed.v1", JSON.stringify(highWater.current)); } catch { /* Practice remains available without storage. */ }
    sessionRef.current = next; setSession(next);
  }, []);
  const pause = useCallback(() => { playingRef.current = false; setPlaying(false); }, []);

  useEffect(() => {
    try {
      const saved: unknown = JSON.parse(window.sessionStorage.getItem("incidentlab.viewed.v1") ?? "{}");
      if (saved && typeof saved === "object" && !Array.isArray(saved)) {
        for (const [id, ms] of Object.entries(saved)) if (/^[a-zA-Z0-9_-]{1,100}$/.test(id) && typeof ms === "number" && Number.isInteger(ms) && ms >= 0 && ms <= scenario.durationMs) highWater.current[id] = ms;
      }
    } catch { /* Invalid observation metadata does not replace saved specifications. */ }
    const { storage, warning } = openTabStorage();
    storageRef.current = storage;
    const restored = readSession(storage, scenarios);
    if (restored.session) commit(restored.session);
    setStorageError(restored.error ?? warning);
    setHydrated(true);
  }, [commit]);
  useEffect(() => {
    if (!hydrated || !session || !storageRef.current) return;
    // Specifications are small; save each cursor update so a reload during playback is recoverable.
    setStorageError(writeSession(storageRef.current, session));
  }, [session, hydrated]);

  const active = session?.attempts.find(a => a.id === session.activeAttemptId) ?? null;
  const computed = useMemo(() => {
    if (!active) return { view: null, error: null };
    try { return { view: simulateRun(active.spec, active.cursorMs), error: null }; }
    catch (e) { return { view: null, error: errorMessage(e, "Не удалось воспроизвести эту попытку.") }; }
  }, [active]);
  const view = computed.view;
  const comparisonState = useMemo(() => {
    if (!selection || !session) return null;
    const left = session.attempts.find(a => a.id === selection.leftId);
    const right = session.attempts.find(a => a.id === selection.rightId);
    if (!left || !right) return null;
    try { return { result: compareRuns(left.spec, right.spec, selection.untilMs), left, right, error: null }; }
    catch (e) { return { result: null, left, right, error: errorMessage(e, "Не удалось сравнить эти попытки.") }; }
  }, [selection, session]);
  const comparison = comparisonState?.result;
  const coachRequest: CoachRequest | null = active ? {
    mode: coachMode,
    primary: comparison && comparisonState ? comparisonState.left.spec : active.spec,
    ...(comparison && comparisonState ? { comparison: comparisonState.right.spec } : {}),
    untilMs: comparison?.untilMs ?? active.cursorMs,
    ...(coachMode === "hint" ? { hintLevel } : {}),
  } : null;
  const coach = useCoach(coachRequest, comparison && selection ? `${selection.leftId}:${selection.rightId}` : active?.id ?? "");
  useEffect(() => {
    if (debriefPending && coachMode === "debrief") { setDebriefPending(false); void coach.ask(); }
  }, [debriefPending, coachMode, coach.ask]);

  const updateActive = useCallback((change: (attempt: SavedAttempt) => SavedAttempt) => {
    const current = sessionRef.current;
    if (current) commit({ ...current, attempts: current.attempts.map(a => a.id === current.activeAttemptId ? change(a) : a) });
  }, [commit]);
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      if (!playingRef.current) return;
      updateActive(attempt => {
        let nextMs = Math.min(scenario.durationMs, attempt.cursorMs + 250 * speed);
        if (attempt.cursorMs < scenario.checkpointMs && nextMs >= scenario.checkpointMs) {
          nextMs = scenario.checkpointMs; pause();
          setNotice("Прогон на паузе. Посмотри запросы и выбери, что изменить.");
        }
        if (nextMs >= scenario.durationMs) pause();
        return { ...attempt, cursorMs: nextMs };
      });
    }, 250);
    return () => clearInterval(timer);
  }, [playing, speed, pause, updateActive]);

  function startNew() {
    pause();
    const attempt = createAttempt(scenario, 42);
    commit({ schemaVersion: 1, activeAttemptId: attempt.id, attempts: [attempt] });
    setStarted(true); setSelection(null); setSelectedRequestId(null); setHighlightEventId(null);
    setCoachMode("hint"); setHintLevel(1);
    setNotice(`Прогон сам остановится на ${time(scenario.checkpointMs)}. Пока можно посмотреть, как меняются метрики.`);
    playingRef.current = true; setPlaying(true);
  }
  function setCursor(cursorMs: number) {
    pause(); setSelection(null); setHighlightEventId(null);
    updateActive(a => ({ ...a, cursorMs: Math.round(Math.min(scenario.durationMs, Math.max(0, cursorMs))) }));
  }
  function apply(type: Intervention["type"], value: number) {
    pause();
    const current = sessionRef.current;
    const attempt = current?.attempts.find(a => a.id === current.activeAttemptId);
    if (!attempt) return;
    try {
      if (attempt.cursorMs < (highWater.current[attempt.id] ?? 0)) throw new Error("Чтобы изменить прошлое, создай отдельную попытку с этой отметки.");
      if (simulateRun(attempt.spec, attempt.cursorMs).controls[CONTROL_KEYS[type]] === value) return;
      const next = appendIntervention(attempt, { atMs: attempt.cursorMs, type, value });
      validateRunSpec(next.spec, next.cursorMs); updateActive(() => next); setSelection(null);
      setNotice(`Изменение записано на ${seconds(attempt.cursorMs)}. Продолжи прогон, чтобы проверить результат.`);
    } catch (e) { setNotice(errorMessage(e, "Не удалось применить это изменение.")); }
  }
  function fork(atCheckpoint: boolean) {
    if (rewindGuard.current) return;
    const current = sessionRef.current;
    const source = current?.attempts.find(a => a.id === current.activeAttemptId);
    if (!current || !source) return;
    pause();
    try {
      if (current.attempts.length >= 26) throw new Error("В этой практике уже 26 попыток. Начни заново, чтобы проверить другие варианты.");
      const point = atCheckpoint ? scenario.checkpointMs : source.cursorMs;
      const next = forkAttempt(source, point, crypto.randomUUID(), `Попытка ${String.fromCharCode(65 + current.attempts.length)}`);
      commit({ ...current, activeAttemptId: next.id, attempts: [...current.attempts, next] });
      rewindGuard.current = true; setTimeout(() => { rewindGuard.current = false; }, 600);
      setSelection(null); setSelectedRequestId(null); setHighlightEventId(null);
      setNotice(`«${attemptLabel(source.label)}» сохранена. Теперь открыта «${attemptLabel(next.label)}» на отметке ${seconds(point)} с тем же потоком запросов. Изменения на этой отметке и позже в неё не попали.`);
    } catch (e) { setNotice(errorMessage(e, "Не удалось создать новую ветку.")); }
  }
  function switchAttempt(id: string) {
    pause();
    if (sessionRef.current) commit({ ...sessionRef.current, activeAttemptId: id });
    setSelection(null); setSelectedRequestId(null); setHighlightEventId(null);
  }
  function compare() {
    pause();
    if (!session || !active || session.attempts.length < 2) return;
    const left = session.attempts.find(a => a.id !== active.id)!;
    setSelection({ leftId: left.id, rightId: active.id, untilMs: scenario.durationMs }); setCoachMode("debrief");
    setTimeout(() => document.getElementById("comparison")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }
  function save() {
    pause();
    if (!sessionRef.current || !storageRef.current) return;
    const error = writeSession(storageRef.current, sessionRef.current); setStorageError(error);
    if (!error) setNotice(`${attemptLabel(active?.label ?? "")} сохранена на ${seconds(active?.cursorMs ?? 0)}. После перезагрузки страницы ты сможешь продолжить с этого места.`);
  }
  function openEvidence(id: string) {
    const split = id.indexOf(":");
    const namespace = id.slice(0, split), eventId = id.slice(split + 1);
    const target = comparison && comparisonState ? namespace === "primary" ? comparisonState.left : comparisonState.right : namespace === "primary" ? active : null;
    const horizon = comparison?.untilMs ?? active?.cursorMs;
    const targetView = comparison ? namespace === "primary" ? comparison.left : comparison.right : view;
    const event = targetView?.events.find(e => e.id === eventId);
    if (!target || horizon === undefined || !sessionRef.current || !event) { setNotice("Это событие отсутствует в текущем прогоне."); return; }
    pause();
    commit({ ...sessionRef.current, activeAttemptId: target.id, attempts: sessionRef.current.attempts.map(a => a.id === target.id ? { ...a, cursorMs: horizon } : a) });
    setSelectedRequestId(event.requestId ?? null); setHighlightEventId(eventId);
    setNotice(`Событие в «${attemptLabel(target.label)}» на отметке ${seconds(event.atMs)}: ${eventMessage(event)}`);
    setTimeout(() => document.getElementById("request-evidence")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }
  const historyLocked = !!active && (active.cursorMs < (highWater.current[active.id] ?? 0) || active.spec.actions.some(a => a.atMs > active.cursorMs));
  const controlsLocked = historyLocked || active?.cursorMs === scenario.durationMs;
  const highlightedEvent = highlightEventId ? view?.events.find(e => e.id === highlightEventId) : null;

  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Перейти к рабочему пространству</a>
    <header className="app-header"><button className="brand" onClick={() => { pause(); setStarted(false); }} aria-label="На главную IncidentLab"><IncidentLogo /><span>Incident<span className="brand-light">Lab</span></span></button><div className="header-divider" /><span className="header-label">Тренажёр дежурного разработчика</span><div className="header-right"><span className="environment-badge"><span />Учебная симуляция</span><button className="text-button help-button" onClick={() => setHelpOpen(v => !v)} aria-expanded={helpOpen}>Как это работает <Icon name="external" size={14} /></button></div></header>
    {helpOpen && <div className="help-banner"><div><strong>Как устроена практика</strong><p>Поставь прогон на паузу и открой запрос, чтобы посмотреть его события. Изменение настройки записывается в текущую попытку. «Новая попытка с {time(scenario.checkpointMs)}» сохраняет её и создаёт другую на этой отметке с тем же потоком запросов. Изменения на этой отметке и позже не переносятся. Ползунок меняет только время просмотра. «Начать заново» запускает кейс с начала и сбрасывает попытки.</p></div><button className="icon-button" aria-label="Закрыть справку" onClick={() => setHelpOpen(false)}><Icon name="close" /></button></div>}
    <main id="main-content">{!started ? <div className="welcome">
      <div className="welcome-intro"><span className="eyebrow"><span className="eyebrow-line" />ПРАКТИКА ДЕЖУРСТВА</span><h1>Сервис тормозит.<br /><span>Попробуй<br className="desktop-break" /> разобраться.</span></h1><p>Посмотри метрики, измени настройку и проверь результат.<br />Можно вернуться назад и попробовать другое решение при той же нагрузке.</p></div>
      <section className="case-card" aria-labelledby="case-title"><div className="case-copy"><div className="case-meta"><span className="case-number">КЕЙС 01</span><span><Icon name="clock" size={14} />{seconds(scenario.durationMs)} модельного времени</span></div><h2 id="case-title">{scenario.title}</h2><p>{scenario.briefing}</p><div className="case-goal"><Icon name="search" size={18} /><span><strong>С чего начать</strong> Открой запрос с ошибкой и посмотри, что с ним произошло.</span></div><div className="start-actions"><button className="button button-primary" onClick={startNew} disabled={!hydrated}>Начать практику <Icon name="arrow" size={18} /></button>{session && <button className="button button-secondary" onClick={() => { setStarted(true); pause(); }}>Продолжить практику <Icon name="right" size={16} /></button>}</div><span className="no-signup"><Icon name="check" size={14} />Без регистрации и подключения инфраструктуры.</span></div><div className="case-illustration" aria-hidden="true"><div className="illustration-grid" /><div className="illustration-pill"><span />СХЕМА КАТАЛОГА</div><div className="illustration-server"><Icon name="server" size={32} /><span>API</span></div><div className="illustration-route"><i /><i /><i /><Icon name="arrow" /></div><div className="illustration-db"><Icon name="database" size={32} /><span>БАЗА ДАННЫХ</span></div><div className="illustration-event"><Icon name="activity" size={16} /><span>Пользователи ждут ответ.<br /><strong>Посмотри, где задерживаются запросы.</strong></span></div></div></section>
      <div className="practice-principles"><div><span>01</span><p><strong>Посмотри запросы</strong>Метрики покажут масштаб сбоя. В истории запроса видно, что происходило с ним по шагам.</p></div><div><span>02</span><p><strong>Измени одну настройку</strong>Продолжи прогон и проверь, стало ли больше успешных ответов.</p></div><div><span>03</span><p><strong>Попробуй другой вариант</strong>Создай попытку с той же точки и сравни результат при одинаковой нагрузке.</p></div></div>{storageError && <div className="message message-warning" role="status">{storageError}</div>}
    </div> : <div className="workspace">
      <div className="workspace-heading"><div><div className="breadcrumb">Практика <Icon name="right" size={12} />Кейс 01</div><h1>{scenario.title}<span className="case-status">{playing ? "Идёт прогон" : view?.finished ? "Прогон завершён" : "Исследование"}</span></h1><p>Проверь, как твои изменения влияют на ответы и очередь.</p></div><div className="heading-actions"><span className="seed-badge">Сид <b>{active?.spec.seed}</b></span><button className="button button-secondary" onClick={startNew}><Icon name="plus" size={16} />Начать заново</button></div></div>
      <div className="session-toolbar"><div className="attempt-tabs" aria-label="Сохранённые попытки">{session?.attempts.map(a => <button key={a.id} className={`attempt-tab ${a.id === active?.id ? "active" : ""}`} aria-pressed={a.id === active?.id} onClick={() => switchAttempt(a.id)}><span className="attempt-dot" />{attemptLabel(a.label)}<span className="attempt-time">{time(a.cursorMs)}</span></button>)}</div><div className="session-actions"><button className="text-button" onClick={save}><Icon name="save" size={16} />Сохранить попытку</button><button className="button button-small button-primary" disabled={(session?.attempts.length ?? 0) < 2} onClick={compare}><Icon name="chart" size={16} />Сравнить попытки</button></div></div>
      {storageError && <div className="message message-warning" role="status">{storageError}</div>}{notice && <div className="notice" role="status"><Icon name="activity" size={16} /><span>{notice}</span><button className="icon-button" aria-label="Закрыть сообщение" onClick={() => setNotice(null)}><Icon name="close" size={15} /></button></div>}{computed.error && <div className="message message-error" role="alert">{computed.error}<button className="text-button" onClick={startNew}>Начать заново</button></div>}
      {view && active && <>
        <section className="playback-panel" aria-label="Управление воспроизведением"><div className="playback-main"><button className="play-button" aria-label={playing ? "Приостановить симуляцию" : "Продолжить симуляцию"} disabled={view.finished} onClick={() => { if (playingRef.current) pause(); else { playingRef.current = true; setPlaying(true); setSelection(null); } }}><Icon name={playing ? "pause" : "play"} size={19} /></button><div className="playback-time"><strong>{time(active.cursorMs)}</strong><span>/ {time(scenario.durationMs)}</span></div><label className="speed-control"><span className="sr-only">Скорость воспроизведения</span><select value={speed} onChange={e => setSpeed(Number(e.target.value))}>{[1, 2, 4, 8].map(n => <option key={n} value={n}>{n}× скорость</option>)}</select></label><span className="playback-state"><span className={playing ? "running-dot" : "paused-dot"} />{playing ? "Воспроизведение" : view.finished ? "Завершено" : "Пауза"}</span><div className="playback-buttons"><button className="text-button" disabled={view.finished} onClick={() => setCursor(scenario.durationMs)}>До конца <Icon name="right" size={15} /></button><button className="button button-small button-secondary" disabled={active.cursorMs < scenario.checkpointMs} onClick={() => fork(true)}><Icon name="rewind" size={16} />Новая попытка с {time(scenario.checkpointMs)}</button></div></div><div className="timeline-control"><label className="sr-only" htmlFor="model-time">Модельное время</label><input id="model-time" type="range" min={0} max={scenario.durationMs} step={250} value={active.cursorMs} onChange={e => setCursor(Number(e.target.value))} /><div className="timeline-labels"><span>00:00</span><span className="checkpoint-label" style={{ left: `${scenario.checkpointMs / scenario.durationMs * 100}%` }}>◆ Точка возврата {time(scenario.checkpointMs)}</span><span>{time(scenario.durationMs)}</span></div></div></section>
        <nav className="workspace-jump-links" aria-label="Панели рабочего пространства"><a href="#observations">Метрики</a><a href="#request-evidence">Запросы</a><a href="#decision-controls">Решение</a><a href="#coach-panel">Помощник</a></nav><div className="workspace-columns"><div className="workspace-primary"><section className="metrics-grid" aria-label="Текущие метрики симуляции"><Metric label="Запросы пользователей" value={count(view.metrics.arrived)} detail="Без учёта повторов" tone="blue" /><Metric label="Успешные" value={count(view.metrics.succeeded)} detail="Пользователь получил ответ" tone="green" /><Metric label="С ошибкой" value={count(view.metrics.failed)} detail="Запрос завершился без ответа" tone="red" /><Metric label="В ожидании" value={count(view.metrics.pending)} detail="Ещё ждут ответа" tone="amber" /></section>
          <section className="panel chart-panel" id="observations"><div className="panel-heading"><div><span className="eyebrow">С НАЧАЛА ПРОГОНА</span><h2>Что происходит с запросами</h2></div><span className="live-label"><span />{playing ? "Идёт модельное время" : "На текущей отметке"}</span></div><RequestChart series={view.series} durationMs={scenario.durationMs} checkpointMs={scenario.checkpointMs} cursorMs={active.cursorMs} /><div className="secondary-metrics"><div><span>Попытки обращения к БД</span><strong>{count(view.metrics.totalAttempts)}<small>из них повторов: {count(view.metrics.retries)}</small></strong></div><div><span>Среднее время ответа</span><strong>{latency(view.metrics.avgLatencyMs)}</strong></div><div><span>Время ответа p95</span><strong>{latency(view.metrics.p95LatencyMs)}</strong></div><p>Время ответа рассчитано только по успешным запросам.</p></div></section>
          <section className="panel topology-panel"><div className="panel-heading"><div><span className="eyebrow">СХЕМА СЕРВИСА</span><h2>Как проходит запрос</h2></div><span className="small-muted">API → обработчики → БД</span></div><Topology metrics={view.metrics} /></section>
          <section className="panel" id="request-evidence"><div className="panel-heading explorer-heading"><div><span className="eyebrow">ВЫБЕРИ ЗАПРОС</span><h2>История запросов</h2></div><Icon name="terminal" size={19} /></div>{highlightedEvent && !highlightedEvent.requestId && <div className="global-evidence" id={`evidence-${highlightedEvent.id}`}><span className="eyebrow">СОБЫТИЕ СИСТЕМЫ · {attemptLabel(active.label)}</span><h3>{eventKind(highlightedEvent.kind)} · {seconds(highlightedEvent.atMs)}</h3><p>{eventMessage(highlightedEvent)}</p>{highlightedEvent.data && <dl className="trace-event-data">{Object.entries(highlightedEvent.data).map(([key, value]) => <div key={key}><dt>{dataLabel(key)}</dt><dd>{dataValue(key, value)}</dd></div>)}</dl>}</div>}<RequestExplorer view={view} selectedRequestId={selectedRequestId} onSelect={id => { pause(); setSelectedRequestId(id); setHighlightEventId(null); }} highlightEventId={highlightEventId} /></section>
        </div><aside className="workspace-aside"><section className="panel decision-panel" id="decision-controls"><div className="panel-heading"><div><span className="eyebrow">В ТЕКУЩЕЙ ПОПЫТКЕ</span><h2>Настройки</h2></div><span className="panel-icon"><Icon name="settings" size={19} /></span></div><p className="panel-description">Новое значение применяется сразу. Прогон встанет на паузу, а изменение попадёт в журнал.</p>{controlsLocked && <div className="message message-warning">{historyLocked ? "Ты смотришь прошлую часть прогона. Чтобы изменить решение, нужна отдельная попытка." : "Прогон дошёл до конца. Для другого решения создай ещё одну попытку."}{historyLocked && <button className="text-button" onClick={() => fork(false)}>Новая попытка отсюда <Icon name="arrow" size={14} /></button>}</div>}
          <div className="decision-controls">{scenario.controls.map(control => <div className="control-group" key={control.type}><label>{control.label}<span className="control-current">{view.controls[CONTROL_KEYS[control.type]]}{control.type === "set-retry-backoff" ? " мс" : ""}</span></label><div className="segmented-control" role="group" aria-label={control.label}>{control.values.map(value => <button key={value} aria-pressed={view.controls[CONTROL_KEYS[control.type]] === value} disabled={controlsLocked} onClick={() => apply(control.type, value)}>{control.type === "set-retry-backoff" && value >= 1000 ? `${value / 1000} с` : value}</button>)}</div><p>{control.description}</p></div>)}</div><div className="decision-footer"><Icon name="clock" size={14} />{controlsLocked ? <>Просмотр на {seconds(active.cursorMs)}.</> : <>Изменение будет записано на {seconds(active.cursorMs)}.</>}</div></section>
          <section className="panel action-panel"><div className="panel-heading"><h2>Журнал решений</h2><span className="count-badge">{active.spec.actions.length}</span></div>{active.spec.actions.length ? <ol className="action-log">{active.spec.actions.map((action, i) => <li key={`${i}-${action.atMs}`} className={action.atMs > active.cursorMs ? "future-action" : ""}><span className="log-marker" /><div><span className="log-time">{seconds(action.atMs)}{action.atMs > active.cursorMs ? " · позже текущей отметки" : ""}</span><p>{scenario.controls.find(c => c.type === action.type)?.label} <strong>→ {action.value}{action.type === "set-retry-backoff" ? " мс" : ""}</strong></p></div></li>)}</ol> : <div className="empty-log"><Icon name="terminal" size={24} /><p>Изменений пока нет.<br /><span>Здесь сохраняются время и новое значение настройки.</span></p></div>}</section>
          <section className="panel coach-panel" id="coach-panel"><div className="panel-heading"><div><span className="eyebrow">ЕСЛИ НУЖНА ПОДСКАЗКА</span><h2><Icon name="sparkles" size={18} />Помощник</h2></div></div><p className="panel-description">Разбор учитывает настройки, метрики и события твоего прогона.</p><div className="coach-modes"><button aria-pressed={coachMode === "hint"} onClick={() => setCoachMode("hint")}>Подсказка</button><button aria-pressed={coachMode === "debrief"} onClick={() => setCoachMode("debrief")}>Разбор</button></div>{coachMode === "hint" && <label className="hint-label">Подробность подсказки<select aria-label="Подробность подсказки" value={hintLevel} onChange={e => setHintLevel(Number(e.target.value) as 1 | 2 | 3)}><option value={1}>1 · Небольшой намёк</option><option value={2}>2 · Где искать</option><option value={3}>3 · Что изменить</option></select></label>}
            {coach.response && <div className="coach-response"><span className={`coach-source ${coach.response.source}`}>{coach.response.source === "nvidia" ? "Разбор ИИ" : "Разбор по правилам"}</span>{coach.response.warning && <p className="coach-warning">{coach.response.warning}</p>}<p className="coach-summary">{coach.response.summary}</p><ul>{coach.response.observations.map((observation, i) => <li key={i}><p>{observation.text}</p><div className="evidence-links">{observation.evidenceEventIds.map((id, j) => <button key={id} onClick={() => openEvidence(id)}><Icon name="external" size={11} />{attemptLabel(id.startsWith("comparison:") ? comparisonState?.right.label ?? "Сравнение" : comparisonState?.left.label ?? active.label)} · Событие {j + 1}</button>)}</div></li>)}</ul><div className="next-experiment"><strong>Следующий эксперимент</strong><p>{coach.response.nextExperiment}</p></div><details><summary>Ограничения разбора</summary>{coach.response.limitations.map((limitation, i) => <p key={i}>{limitation}</p>)}</details></div>}{coach.error && <div className="message message-warning" role="alert">{coach.error}</div>}{coach.loading && <div className="coach-loading" role="status"><span className="spinner" />Готовится разбор…<small>Пока можно смотреть метрики и запросы.</small></div>}<button className="button button-coach" disabled={coach.loading || playing} onClick={() => { pause(); void coach.ask(); }}><Icon name={coach.error ? "refresh" : "sparkles"} size={16} />{coach.loading ? "Идёт разбор…" : coach.error ? "Повторить запрос" : coach.response ? "Обновить разбор" : coachMode === "hint" ? "Получить подсказку" : "Получить разбор"}</button>{playing && <p className="small-muted coach-pause-note">Останови прогон, чтобы запросить разбор на этой отметке.</p>}<p className="coach-footnote">Прогон и сравнение работают без помощника.</p></section>
        </aside></div>
        {comparisonState?.error && <div className="message message-error" role="alert">{comparisonState.error}</div>}{comparison && comparisonState && <section id="comparison"><ComparisonPanel comparison={comparison} leftLabel={attemptLabel(comparisonState.left.label)} rightLabel={attemptLabel(comparisonState.right.label)} onClose={() => setSelection(null)} onDebrief={() => { pause(); setCoachMode("debrief"); setDebriefPending(true); document.getElementById("coach-panel")?.scrollIntoView({ behavior: "smooth", block: "center" }); }} /></section>}
      </>}
    </div>}</main><footer className="app-footer"><span><span className="footer-logo">IL</span>IncidentLab <span className="footer-separator">/</span> Команда nexelle</span><span>Модель каталога с заданной нагрузкой.</span></footer>
  </div>;
}

function Metric({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: string }) {
  return <div className={`metric metric-${tone}`}><span className="metric-label"><i />{label}</span><strong>{value}</strong><span className="metric-detail">{detail}</span></div>;
}
