import { createCoachHandler } from "@/lib/server/coach-handler";
export const runtime = "nodejs";
export const maxDuration = 25;
export const POST = createCoachHandler();
