import { scoped } from "@/lib/auth";
import { loadRuntimeSettings, saveRuntimeSettings, scheduler, type RuntimeSettings } from "@/lib/runtime";

export const dynamic = "force-dynamic";

export const GET = scoped(async () => {
  return Response.json({ settings: loadRuntimeSettings() });
});

export const PUT = scoped(async (req: Request) => {
  const patch = (await req.json().catch(() => ({}))) as Partial<RuntimeSettings>;
  const next: RuntimeSettings = { ...loadRuntimeSettings(), ...patch };
  // Keep concurrency sane; the scheduler reads this on every tick.
  next.concurrency = Math.max(1, Math.min(8, Math.floor(next.concurrency || 1)));
  saveRuntimeSettings(next);
  scheduler().kick();
  return Response.json({ settings: next });
});