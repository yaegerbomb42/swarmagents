/**
 * Step 8.3 — Container spec & CLI argument generation (Docker / Podman).
 *
 * Translates a declarative {@link ContainerEnvConfig} into the runtime arguments that
 * enforce the sandbox environment: CPU and memory caps, an optional network airgap,
 * and read-only host mounts. The returned argv is identical for Docker and Podman
 * (they share the `run` CLI surface); the caller prefixes the runtime binary.
 */

export interface MountPoint {
  /** Host-side path made available inside the container. */
  source: string;
  /** Container-side mount target. */
  target: string;
  /**
   * Defaults to `true`: binds are read-only unless explicitly marked writable. This is
   * the enforcement default — a shadow workspace must never be writable by accident.
   */
  readOnly?: boolean;
}

export interface ContainerEnvConfig {
  /** CPU cap (`--cpus`). */
  cpuLimit: number;
  /** Memory cap in whole megabytes, rendered as `--memory=<n>m`. */
  memoryLimitMb: number;
  /** `true` → `--network=none`: no outbound network from the container. */
  airgap: boolean;
  /** Host mounts. Read-only unless a point opts into `readOnly: false`. */
  binds: MountPoint[];
}

function mountSpec(mount: MountPoint): string {
  const mode = mount.readOnly === false ? 'rw' : 'ro';
  return `${mount.source}:${mount.target}:${mode}`;
}

/**
 * Build the `{docker,podman} run` argv enforcing the container environment.
 *
 * @param cfg - The declarative container environment.
 * @param image - Container image to run.
 * @param command - Tokens appended after the image (the in-container command). Defaults to none.
 */
export function buildContainerRunArgs(
  cfg: ContainerEnvConfig,
  image: string,
  command: readonly string[] = [],
): string[] {
  return [
    'run',
    '--rm',
    '--cpus',
    String(cfg.cpuLimit),
    `--memory=${cfg.memoryLimitMb}m`,
    ...(cfg.airgap ? ['--network=none'] : []),
    ...cfg.binds.flatMap((mount) => ['-v', mountSpec(mount)]),
    image,
    ...command,
  ];
}
