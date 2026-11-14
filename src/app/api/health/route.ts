import { health } from "@/lib/server/provider";
export const runtime = "nodejs";
export function GET(): Response { return Response.json(health(), { headers: { "Cache-Control": "no-store" } }); }
