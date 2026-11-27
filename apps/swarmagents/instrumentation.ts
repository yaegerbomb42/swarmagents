/**
 * Server startup hook (Next.js instrumentation). Registers the graceful
 * shutdown handler once per process so a SIGTERM/SIGINT during a deploy
 * cancels in-flight runs with reason "shutdown" and flushes run logs
 * before the process exits. Also moves the legacy server-wide providers.json
 * into the owner's account (SWARM_OWNER_EMAIL) once, so no provider is ever
 * shared across accounts, and builds the share token index once, so share
 * links created before the index existed keep resolving.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Last-resort guard for child-process stream errors (EPIPE and friends).
    // A docker CLI that exits before its stdin is drained must fail only the
    // request that spawned it, never the whole server. Installed first so it
    // is in place even if a later startup task throws.
    const { installCrashGuard } = await import("./lib/vm/stream-errors");
    installCrashGuard();
    // Fail boot loudly in server mode without a session secret (Tier 1 #1):
    // without it there is no authentication at all. Skipped during
    // `next build` (NEXT_PHASE=phase-production-build): a build must not fail
    // on a runtime secret that is only needed when the server serves.
    if (process.env.NEXT_PHASE !== "phase-production-build") {
      const { assertServerModeSecret } = await import("./lib/auth");
      assertServerModeSecret();
    }
    const { registerShutdownHandler } = await import("./lib/runtime/shutdown");
    registerShutdownHandler();
    const { reconcileInterruptedRunsOnStartup } = await import("./lib/runtime/recovery");
    reconcileInterruptedRunsOnStartup();
    const { migrateLegacyProvidersAtStartup } = await import("./lib/providers/migrate");
    migrateLegacyProvidersAtStartup();
    // One-time share token index (bug 19): after this, resolving a share
    // link is a single file read instead of a scan of every account.
    const { ensureShareIndex } = await import("./lib/projects/store");
    ensureShareIndex();
    if (process.env.SWARM_AMBIENT_WATCHERS !== "0" && process.env.NEXT_PHASE !== "phase-production-build") {
      const { startAmbientWatchers } = await import("./lib/ambient/runtime");
      startAmbientWatchers();
      // Scheduled workflows share the ambient-watchers gate: the same
      // background lifecycle, one unref'd interval each, never blocking a
      // request handler.
      const { startScheduleTicks } = await import("./lib/runtime/schedules");
      startScheduleTicks();
    }
    // Next.js route handlers cannot upgrade WebSockets, so the owner-only
    // desktop proxy (lib/desktop-proxy) runs as a small dedicated Node server
    // in this same process on an internal port (default 127.0.0.1:3778).
    if (process.env.SWARM_DESKTOP_PROXY_DISABLED !== "1") {
      const { createDesktopProxy, setGlobalDesktopProxy } = await import("./lib/desktop-proxy/proxy");
      const { getRunsDir } = await import("./lib/telemetry/paths");
      const { getRuntimeManager } = await import("./lib/runtime/manager");
      const { desktopReplayDir } = await import("./lib/runtime/desktop-replay");
      const runsDir = getRunsDir();
      // Run-tagged viewer sessions feed the run's desktop replay. Recording is
      // capped per session by FrameRecorder; SWARM_DESKTOP_REPLAY=0 turns it off.
      const proxy = createDesktopProxy({
        // Must match where attachDesktopReplay looks (<runsDir>/replays).
        recordingDir: process.env.SWARM_DESKTOP_REPLAY === "0" || !runsDir ? undefined : desktopReplayDir(runsDir),
        isActiveRun: (userId, runId) => getRuntimeManager().isActiveRun(userId, runId),
      });
      // Expose the proxy to the runtime so desktop handoffs can force
      // view/control mode on the user's sessions.
      setGlobalDesktopProxy(proxy);
      proxy.listen().catch((err) => {
        console.error("[desktop-proxy] failed to start:", err);
      });
    }
    // Bring-your-own-compute nodes dial OUTBOUND to this websocket server,
    // so it has to be reachable from the internet (a reverse proxy routes
    // /byoc/ to it). It runs in the same process on an internal port
    // (default 127.0.0.1:3779).
    if (process.env.SWARM_BYOC_DISABLED !== "1") {
      const { getByocHub } = await import("./lib/byoc/hub");
      const hub = getByocHub();
      hub.listen().catch((err) => {
        console.error("[byoc-hub] failed to start:", err);
      });
    }
  }
}
