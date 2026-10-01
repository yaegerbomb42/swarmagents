// Next.js calls register() once when the server starts. Runs cut off by a crash or restart resume here,
// which is what lets a single task survive for days. The node-only import stays behind the runtime check so
// the edge bundle never sees it.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") await import("./instrumentation-node");
}
