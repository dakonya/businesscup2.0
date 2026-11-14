"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CoachRequest, CoachResponse } from "../contracts";

class CoachError extends Error {}

function isResponse(value: unknown): value is CoachResponse {
  if (typeof value !== "object" || value === null) return false;
  const response = value as Record<string, unknown>;
  return (
    (response.source === "nvidia" || response.source === "rules") &&
    typeof response.summary === "string" &&
    typeof response.nextExperiment === "string" &&
    (response.warning === undefined || typeof response.warning === "string") &&
    Array.isArray(response.limitations) && response.limitations.every((item) => typeof item === "string") &&
    Array.isArray(response.observations) && response.observations.every((item: unknown) => {
      if (typeof item !== "object" || item === null) return false;
      const observation = item as Record<string, unknown>;
      return typeof observation.text === "string" &&
        Array.isArray(observation.evidenceEventIds) &&
        observation.evidenceEventIds.every((id) =>
          typeof id === "string" && /^(primary|comparison):.+$/.test(id));
    })
  );
}

/** Explicit requests only. Changing the experiment immediately invalidates old replies. */
export function useCoach(request: CoachRequest | null, contextKey = "") {
  const [response, setResponse] = useState<CoachResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const requestKey = JSON.stringify(request);
  const identityKey = JSON.stringify([contextKey, requestKey]);
  const latestKey = useRef(identityKey);
  latestKey.current = identityKey;

  const reset = useCallback(() => {
    generation.current += 1;
    pending.current?.abort();
    pending.current = null;
    setResponse(null);
    setError(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    reset();
    return () => {
      generation.current += 1;
      pending.current?.abort();
    };
  }, [identityKey, reset]);

  const ask = useCallback(async () => {
    const current = JSON.parse(requestKey) as CoachRequest | null;
    if (!current || latestKey.current !== identityKey || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    const token = ++generation.current;
    const isCurrent = () => generation.current === token && latestKey.current === identityKey;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 22_000);
    setResponse(null);
    setError(null);
    setLoading(true);
    try {
      const result = await fetch("/api/coach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: requestKey,
        signal: controller.signal,
      });
      if (!result.ok) {
        if (result.status === 429) throw new CoachError("The coach is busy. Wait a moment and try again.");
        throw new CoachError("The coach could not respond. Your practice and comparison are still available.");
      }
      const payload: unknown = await result.json();
      if (!isResponse(payload)) throw new CoachError("The coach returned an unreadable recap. Please try again.");
      if (isCurrent()) setResponse(payload);
    } catch (cause) {
      if (!isCurrent()) return;
      if (timedOut) setError("The coach took too long. Please try again. You can continue practicing.");
      else if (!controller.signal.aborted) {
        setError(cause instanceof CoachError
          ? cause.message
          : "The coach is unavailable. Please try again. Your practice is still available.");
      }
    } finally {
      clearTimeout(timeout);
      if (isCurrent()) {
        pending.current = null;
        setLoading(false);
      }
    }
  }, [requestKey, identityKey]);

  return { response, loading, error, ask, reset };
}
