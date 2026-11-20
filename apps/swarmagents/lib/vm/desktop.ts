/**
 * Desktop-mode selection for the per-user VM driver.
 *
 * The desktop image (`swarm-vm:desktop`) is selected by `SWARM_VM_DESKTOP=1`
 * (the driver then uses `SWARM_VM_DESKTOP_IMAGE`, default `swarm-vm:desktop`).
 * When the variable is unset everything behaves exactly as before with
 * `swarm-vm:claude` — no desktop, no VNC, no computer-use MCP servers.
 *
 * This module is dependency-free and server-only-agnostic so both the VM
 * driver and the harness (role MCP wiring) can consult the same flag.
 */

/** Env var turning desktop mode on. */
export const SWARM_VM_DESKTOP_ENV = "SWARM_VM_DESKTOP";
/** Env var overriding the desktop image tag. */
export const SWARM_VM_DESKTOP_IMAGE_ENV = "SWARM_VM_DESKTOP_IMAGE";

/** The desktop image tag shipped by the repo (vm-image-desktop/). */
export const DESKTOP_IMAGE_DEFAULT = "swarm-vm:desktop";
/** The legacy agent image tag (unchanged behavior when desktop mode is off). */
export const CLAUDE_IMAGE_DEFAULT = "swarm-vm:claude";

/** True when desktop mode is enabled (SWARM_VM_DESKTOP=1). */
export function isDesktopModeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[SWARM_VM_DESKTOP_ENV] === "1";
}

/** The desktop image reference, or null when desktop mode is off. */
export function desktopImage(env: Record<string, string | undefined> = process.env): string | null {
  if (!isDesktopModeEnabled(env)) return null;
  const override = env[SWARM_VM_DESKTOP_IMAGE_ENV]?.trim();
  return override || DESKTOP_IMAGE_DEFAULT;
}

/** The effective VM image: desktop image when desktop mode is on, else `fallback`. */
export function resolveVmImage(
  fallback: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return desktopImage(env) ?? fallback;
}
