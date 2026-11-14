import { buildFacts } from "./facts";
import { apiError, BodyLimitError, readBoundedBody } from "./http";
import { createLimiter, type CoachLimiter } from "./limits";
import { getCoach, type CoachEnv } from "./provider";
import { coachRequestSchema } from "./validation";

export const MAX_BODY_BYTES = 16_384;
export function createCoachHandler(options: { limiter?: CoachLimiter; env?: CoachEnv; fetcher?: typeof fetch; timeoutMs?: number } = {}) {
  const limiter = options.limiter ?? createLimiter();
  return async function POST(request: Request): Promise<Response> {
    const advertised = Number(request.headers.get("content-length"));
    if (Number.isFinite(advertised) && advertised > MAX_BODY_BYTES) return apiError(413, "BODY_TOO_LARGE", "Coach request exceeds 16 KiB.");
    let body: unknown;
    try { body = JSON.parse(await readBoundedBody(request.body, MAX_BODY_BYTES)); }
    catch (error) { return error instanceof BodyLimitError ? apiError(413, "BODY_TOO_LARGE", "Coach request exceeds 16 KiB.") : apiError(400, "INVALID_JSON", "Send a valid JSON coach request."); }
    const parsed = coachRequestSchema.safeParse(body);
    if (!parsed.success) return apiError(400, "INVALID_INPUT", "Invalid coach request. Check the scenario, seed, ordered actions, control values, and horizon.");
    const client = (request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "anonymous").slice(0, 160);
    const release = limiter.acquire(client);
    if (!release) return apiError(429, "RATE_LIMITED", "Coach request limit reached. Please wait one minute before retrying.");
    try {
      const facts = buildFacts(parsed.data);
      const result = await getCoach(parsed.data, facts, options);
      return Response.json(result, { headers: { "Cache-Control": "no-store" } });
    } finally { release(); }
  };
}
