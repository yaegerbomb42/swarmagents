const DEFAULT_HOME = "/home/user";

const SECRET_EXACT_PATHS = new Set([
  "/etc/shadow",
  "/etc/gshadow",
  "/etc/master.passwd",
  "/etc/sudoers",
  "/etc/passwd",
]);

const PERSISTENCE_SYSTEM_PREFIXES = [
  "/etc/cron",
  "/var/spool/cron",
  "/etc/systemd/system",
  "/usr/lib/systemd/system",
  "/lib/systemd/system",
  "/etc/init.d",
  "/etc/profile.d",
];

const PERSISTENCE_EXACT_FILES = new Set([
  "/etc/rc.local",
  "/etc/profile",
  "/etc/bash.bashrc",
  "/etc/zsh/zshrc",
  "/etc/crontab",
]);

const SYSTEM_CRITICAL_PREFIXES = [
  "/etc",
  "/bin",
  "/sbin",
  "/usr",
  "/lib",
  "/lib64",
  "/boot",
  "/dev",
  "/proc",
  "/sys",
  "/var",
  "/run",
  "/opt",
  "/root",
];

const STD_DEVICES = new Set([
  "/dev/null",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/zero",
  "/dev/urandom",
  "/dev/random",
  "/dev/tty",
]);

export function normalizePosixPath(inputPath: string): string {
  if (!inputPath) return "/";
  const isAbs = inputPath.startsWith("/");
  const rawParts = inputPath.split("/");
  const stack: string[] = [];

  for (let i = 0; i < rawParts.length; i++) {
    const part = rawParts[i]!;
    if (!part || part === ".") continue;
    if (part === "..") {
      if (stack.length > 0 && stack[stack.length - 1] !== "..") {
        stack.pop();
      } else if (!isAbs) {
        stack.push("..");
      }
    } else {
      stack.push(part);
    }
  }

  const joined = stack.join("/");
  if (isAbs) {
    return "/" + joined;
  }
  return joined || ".";
}

export function expandTilde(rawPath: string, homeDir: string): string {
  const cleanHome = normalizePosixPath(homeDir || DEFAULT_HOME);
  if (rawPath === "~") return cleanHome;
  if (rawPath.startsWith("~/")) {
    return normalizePosixPath(`${cleanHome}/${rawPath.slice(2)}`);
  }
  if (rawPath.startsWith("~")) {
    const slashIdx = rawPath.indexOf("/");
    if (slashIdx === -1) {
      const user = rawPath.slice(1);
      return user === "root" ? "/root" : `/home/${user}`;
    }
    const user = rawPath.slice(1, slashIdx);
    const rest = rawPath.slice(slashIdx + 1);
    const userHome = user === "root" ? "/root" : `/home/${user}`;
    return normalizePosixPath(`${userHome}/${rest}`);
  }
  return rawPath;
}

export function resolveCommandPath(
  rawPath: string,
  cwd: string,
  homeDir: string = DEFAULT_HOME,
): string {
  const normalizedCwd = normalizePosixPath(
    cwd.startsWith("/") ? cwd : `/${cwd}`,
  );
  const expanded = expandTilde(rawPath, homeDir);
  if (expanded.startsWith("/")) {
    return normalizePosixPath(expanded);
  }
  return normalizePosixPath(`${normalizedCwd}/${expanded}`);
}

export function isStandardDevice(resolvedPath: string): boolean {
  return STD_DEVICES.has(resolvedPath);
}

export function isWithinWorkspace(
  resolvedPath: string,
  workspaceRoot: string,
): boolean {
  const cleanRoot = normalizePosixPath(workspaceRoot);
  const cleanTarget = normalizePosixPath(resolvedPath);
  if (cleanRoot === "/") return true;
  return (
    cleanTarget === cleanRoot || cleanTarget.startsWith(`${cleanRoot}/`)
  );
}

export function isWorkspaceRootItself(
  resolvedPath: string,
  workspaceRoot: string,
): boolean {
  return normalizePosixPath(resolvedPath) === normalizePosixPath(workspaceRoot);
}

export function isSystemCriticalPath(resolvedPath: string): boolean {
  const p = normalizePosixPath(resolvedPath);
  if (p === "/") return true;
  for (const prefix of SYSTEM_CRITICAL_PREFIXES) {
    if (p === prefix || p.startsWith(`${prefix}/`)) {
      return true;
    }
  }
  return false;
}

export interface PathSensitivity {
  isSecret: boolean;
  secretSeverity: "block" | "review" | null;
  secretReason?: string;
  isPersistence: boolean;
  persistenceReason?: string;
}

export function classifyPathSensitivity(
  resolvedPath: string,
  homeDir: string = DEFAULT_HOME,
): PathSensitivity {
  const p = normalizePosixPath(resolvedPath);
  const cleanHome = normalizePosixPath(homeDir || DEFAULT_HOME);
  const baseName = p.slice(p.lastIndexOf("/") + 1);

  // 1. Secret checks
  if (p === "/etc/passwd") {
    return {
      isSecret: true,
      secretSeverity: "review",
      secretReason: "Access to system user database (/etc/passwd)",
      isPersistence: false,
    };
  }

  if (SECRET_EXACT_PATHS.has(p) || p.startsWith("/etc/sudoers.d/")) {
    return {
      isSecret: true,
      secretSeverity: "block",
      secretReason: `Access to sensitive system security file (${p})`,
      isPersistence: false,
    };
  }

  // SSH keys & directory
  if (
    p === `${cleanHome}/.ssh` ||
    p.startsWith(`${cleanHome}/.ssh/`) ||
    p.includes("/.ssh/") ||
    baseName === "id_rsa" ||
    baseName.startsWith("id_rsa.") ||
    baseName === "id_ed25519" ||
    baseName.startsWith("id_ed25519.") ||
    baseName === "id_ecdsa" ||
    baseName === "id_dsa" ||
    baseName === "authorized_keys"
  ) {
    return {
      isSecret: true,
      secretSeverity: "block",
      secretReason: `Access to SSH directory or key material (${p})`,
      isPersistence:
        baseName === "authorized_keys" || baseName === "config",
      persistenceReason:
        baseName === "authorized_keys" || baseName === "config"
          ? `Modification of SSH persistence file (${p})`
          : undefined,
    };
  }

  // Private certificates & keystores
  if (
    /\.(pem|key|p12|pfx|jks|keystore|ppk)$/i.test(baseName) &&
    !p.includes("/node_modules/") &&
    !p.includes("/ssl/certs/ca-certificates")
  ) {
    return {
      isSecret: true,
      secretSeverity: "block",
      secretReason: `Access to private key or certificate file (${p})`,
      isPersistence: false,
    };
  }

  // .env files (allow safe template files like .env.example / .env.sample / .env.template)
  if (baseName === ".env" || baseName.startsWith(".env.")) {
    const isTemplate =
      /^\.env\.(example|sample|template|schema|defaults)$/i.test(baseName);
    if (!isTemplate) {
      return {
        isSecret: true,
        secretSeverity: "block",
        secretReason: `Access to environment secret file (${p})`,
        isPersistence: false,
      };
    }
  }

  // Cloud & package manager credentials
  if (
    p === `${cleanHome}/.aws/credentials` ||
    p === `${cleanHome}/.aws/config` ||
    p.endsWith("/.aws/credentials") ||
    p.startsWith(`${cleanHome}/.config/gcloud/`) ||
    baseName === "application_default_credentials.json" ||
    p.startsWith(`${cleanHome}/.azure/`) ||
    p === `${cleanHome}/.kube/config` ||
    p.endsWith("/.kube/config") ||
    p === `${cleanHome}/.docker/config.json` ||
    p === `${cleanHome}/.npmrc` ||
    p === `${cleanHome}/.pypirc` ||
    p === `${cleanHome}/.netrc` ||
    p === `${cleanHome}/.git-credentials` ||
    p === `${cleanHome}/.config/gh/hosts.yml` ||
    p === `${cleanHome}/.gh/hosts.yml` ||
    p.startsWith("/var/run/secrets/kubernetes.io/")
  ) {
    return {
      isSecret: true,
      secretSeverity: "block",
      secretReason: `Access to cloud or CLI credential file (${p})`,
      isPersistence: false,
    };
  }

  // 2. Persistence checks
  if (PERSISTENCE_EXACT_FILES.has(p)) {
    return {
      isSecret: false,
      secretSeverity: null,
      isPersistence: true,
      persistenceReason: `Targets system startup or cron file (${p})`,
    };
  }

  for (const prefix of PERSISTENCE_SYSTEM_PREFIXES) {
    if (p === prefix || p.startsWith(`${prefix}/`)) {
      return {
        isSecret: false,
        secretSeverity: null,
        isPersistence: true,
        persistenceReason: `Targets system persistence directory (${p})`,
      };
    }
  }

  if (
    p.startsWith(`${cleanHome}/.config/systemd/user/`) ||
    p.startsWith(`${cleanHome}/.config/autostart/`) ||
    p === `${cleanHome}/.bashrc` ||
    p === `${cleanHome}/.bash_profile` ||
    p === `${cleanHome}/.bash_login` ||
    p === `${cleanHome}/.profile` ||
    p === `${cleanHome}/.zshrc` ||
    p === `${cleanHome}/.zprofile` ||
    p === `${cleanHome}/.zshenv` ||
    p === `${cleanHome}/.vimrc` ||
    p === `${cleanHome}/.gitconfig`
  ) {
    return {
      isSecret: false,
      secretSeverity: null,
      isPersistence: true,
      persistenceReason: `Targets user shell rc or startup configuration (${p})`,
    };
  }

  return {
    isSecret: false,
    secretSeverity: null,
    isPersistence: false,
  };
}
