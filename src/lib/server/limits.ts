// Best-effort process-local budget: deliberately bounded, never distributed protection.
export function createLimiter(options: { perClient?: number; global?: number; concurrent?: number; windowMs?: number; now?: () => number } = {}) {
  const { perClient = 6, global = 60, concurrent = 2, windowMs = 60_000, now = Date.now } = options;
  const clients = new Map<string, number>(); let windowStart = now(); let total = 0; let active = 0;
  return {
    acquire(client: string): (() => void) | undefined {
      const time = now();
      if (time - windowStart >= windowMs) { clients.clear(); total = 0; windowStart = time; }
      if (active >= concurrent || total >= global || (clients.get(client) ?? 0) >= perClient || (!clients.has(client) && clients.size >= 1_000)) return;
      clients.set(client, (clients.get(client) ?? 0) + 1); total++; active++;
      let released = false;
      return () => { if (!released) { active--; released = true; } };
    },
  };
}
export type CoachLimiter = ReturnType<typeof createLimiter>;
