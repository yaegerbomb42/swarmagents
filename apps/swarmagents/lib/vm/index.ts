// VM module — server-only persistent Linux sandbox manager.
//
// Usage:
//   import { vmManager } from "./lib/vm/index.js";
//   const handle = await vmManager.ensure("user-123");
//   await vmManager.exec("user-123", ["ls", "-la"], { onStdout: console.log });
//   await vmManager.writeFile("user-123", "/workspace/hello.txt", "Hello");

export type {
  VmHandle,
  ExecOptions,
  ExecResult,
  VmState,
  VmStatus,
  VmSnapshot,
  VmDriver,
  VmEntryType,
  VmFileStat,
  VmDirEntry,
  VmFileBytes,
  VmDesktopEndpoint,
} from "./types";

export {
  DockerVmDriver,
  sanitizeId,
  containerNameFor,
  volumeNameFor,
  snapshotRepoFor,
  snapshotVolumeFor,
  ownerKeyFor,
  userResourceBase,
  VM_OWNER_LABEL,
  VM_OWNER_KEY_HEX,
  USER_SLUG_MAX,
  legacyContainerNameFor,
  legacyVolumeNameFor,
  SWARM_VM_IMAGE,
  SWARM_VM_DESKTOP,
  SWARM_VM_DESKTOP_IMAGE,
  DEFAULT_DESKTOP_IMAGE,
  DESKTOP_DISPLAY,
  DESKTOP_VNC_PORT,
  DESKTOP_SHM_SIZE,
  DESKTOP_VNC_PASSWORD_ENV,
  DESKTOP_VNC_PASSWORD_FILE,
  generateVncPassword,
  SWARM_VM_MEMORY,
  SWARM_VM_CPUS,
  SWARM_VM_PIDS,
  SWARM_VM_PIDS_LIMIT,
  VM_CAPABILITIES,
  VM_RUNTIME_ENV,
  VM_RUNTIME_ALLOWLIST,
  VmRuntimeError,
  validateVmRuntime,
  resolveVmRuntime,
  isRuntimeMissingError,
  VM_NETWORK_ENV,
  VmNetworkError,
  validateVmNetwork,
  resolveVmNetwork,
  validateEnvName,
  buildExecArgs,
  buildRunArgs,
  buildUpdateArgs,
  buildTimeoutWrap,
  validateSnapshotName,
  validateSnapshotLabel,
  type DockerVmDriverOptions,
} from "./docker-driver";
export {
  SWARM_VM_DESKTOP_ENV,
  SWARM_VM_DESKTOP_IMAGE_ENV,
  DESKTOP_IMAGE_DEFAULT,
  CLAUDE_IMAGE_DEFAULT,
  isDesktopModeEnabled,
  desktopImage,
  resolveVmImage,
} from "./desktop";
export {
  DEFAULT_VM_MEMORY,
  DEFAULT_VM_DESKTOP_MEMORY,
  DEFAULT_VM_CPUS,
  DEFAULT_VM_PIDS,
  VM_MEMORY_ENV,
  VM_CPUS_ENV,
  VM_PIDS_ENV,
  VM_PIDS_LEGACY_ENV,
  VmLimitError,
  resolveVmLimits,
  validateMemoryLimit,
  validateCpuLimit,
  validatePidsLimit,
  type VmLimits,
} from "./limits";
export { FakeVmDriver } from "./fake-driver";
export {
  SWARM_VM_WARM_POOL_SIZE_ENV,
  WarmPool,
  resolveWarmPoolSize,
  type WarmPoolDriver,
} from "./warm-pool";
export {
  ByocVmDriver,
  BYOC_CONTAINER_PREFIX,
  DEFAULT_BYOC_RESUME_TIMEOUT_MS,
  type ByocVmDriverOptions,
} from "./drivers/byoc";
export {
  DEFAULT_VM_IDLE_MIN,
  DEFAULT_VM_SWEEP_INTERVAL_SEC,
  SWARM_VM_ALWAYS_ON_USERS_ENV,
  parseAlwaysOnUsers,
  parseIdleMinutes,
  parseSweepIntervalSeconds,
  resolveIdlePolicy,
  type VmIdleOptions,
  type VmIdlePolicy,
} from "./idle";
export {
  IdleSweeper,
  startVmIdleSweeper,
  stopVmIdleSweeper,
  type IdleSweeperOptions,
  type SetIntervalFn,
  type ClearIntervalFn,
  type SweepTimerHandle,
} from "./idle-sweeper";
export {
  VmFileError,
  VmPathError,
  WORKSPACE_ROOT,
  MAX_FILE_READ_BYTES,
  resolveWorkspacePath,
  parentPath,
  looksBinary,
  type VmFileErrorCode,
  type VmPathErrorCode,
} from "./files";
export {
  QuotaError,
  OutputCap,
  TRUNCATION_MARKER,
  DEFAULT_VM_QUOTAS,
  resolveVmQuotas,
  sliceToByteLimit,
  type QuotaKind,
  type VmQuotaOptions,
} from "./quotas";
export {
  VmManager,
  vmManager,
  bindExec,
  getVmManager,
  setVmManagerForTesting,
  VM_WORKSPACE_DISK_PATH,
  DISK_USAGE_TTL_MS,
  type BoundVmExec,
  type DriverName,
  type VmManagerOptions,
  type VmDiskUsage,
} from "./manager";
