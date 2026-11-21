import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CapabilityEntry } from "../schema";
import { truncateSummary } from "../schema";

const execFileAsync = promisify(execFile);

const SCRIPTABLE_APPS = new Set([
  "blender",
  "visual studio code",
  "cursor",
  "obsidian",
  "adobe photoshop",
  "adobe illustrator",
  "microsoft excel",
  "microsoft word",
  "keynote",
  "numbers",
  "pages",
  "finder",
  "mail",
  "safari",
  "google chrome",
  "firefox",
  "iterm",
  "terminal",
  "slack",
  "spotify",
  "music",
  "notes",
  "reminders",
  "calendar",
  "libreoffice",
  "gimp",
  "inkscape",
  "vlc",
  "obs",
  "shortcuts",
]);

function isScriptable(appName: string): boolean {
  const lower = appName.toLowerCase();
  for (const known of SCRIPTABLE_APPS) {
    if (lower.includes(known)) return true;
  }
  return false;
}

function makeAppEntry(
  name: string,
  appPath: string,
  source: string,
  comment?: string
): CapabilityEntry {
  const scriptable = isScriptable(name);
  const baseDesc = comment
    ? comment
    : scriptable
      ? `Scriptable desktop application (${name})`
      : `Desktop application (${name})`;
  const summary = truncateSummary(
    scriptable && !baseDesc.toLowerCase().includes("scriptable")
      ? `${baseDesc} [scriptable]`
      : baseDesc
  );

  return {
    id: `app:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    kind: "desktop_app",
    name,
    summary,
    risk: scriptable ? "writes-files" : "read-only",
    schema: {
      path: appPath,
      scriptable,
    },
    source,
  };
}

async function scanMacApps(): Promise<CapabilityEntry[]> {
  const dirs = ["/Applications", path.join(os.homedir(), "Applications")];
  const entries: CapabilityEntry[] = [];
  const seen = new Set<string>();

  for (const dir of dirs) {
    let items: string[];
    try {
      items = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const item of items) {
      if (!item.endsWith(".app")) continue;
      const name = item.replace(/\.app$/, "");
      if (seen.has(name)) continue;
      seen.add(name);
      entries.push(makeAppEntry(name, path.join(dir, item), "apps:macos"));
    }
  }
  return entries;
}

async function scanLinuxApps(): Promise<CapabilityEntry[]> {
  const dirs = [
    "/usr/share/applications",
    path.join(os.homedir(), ".local", "share", "applications"),
  ];
  const entries: CapabilityEntry[] = [];
  const seen = new Set<string>();

  for (const dir of dirs) {
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".desktop")) continue;
      const fullPath = path.join(dir, file);
      try {
        const content = await fs.readFile(fullPath, "utf8");
        const nameMatch = content.match(/^Name=(.+)$/m);
        const commentMatch = content.match(/^Comment=(.+)$/m);
        const name = nameMatch?.[1]?.trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        entries.push(
          makeAppEntry(name, fullPath, "apps:linux-desktop", commentMatch?.[1]?.trim())
        );
      } catch {
        continue;
      }
    }
  }
  return entries;
}

async function scanWindowsApps(): Promise<CapabilityEntry[]> {
  const entries: CapabilityEntry[] = [];
  const seen = new Set<string>();

  // 1. Start Menu shortcuts
  const startMenuDirs = [
    path.join(
      process.env.ProgramData ?? "C:\\ProgramData",
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs"
    ),
    path.join(
      process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs"
    ),
  ];

  for (const dir of startMenuDirs) {
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".lnk")) continue;
      const name = file.replace(/\.lnk$/i, "");
      if (seen.has(name)) continue;
      seen.add(name);
      entries.push(
        makeAppEntry(name, path.join(dir, file), "apps:windows-startmenu")
      );
    }
  }

  // 2. Registry App Paths
  try {
    const { stdout } = await execFileAsync(
      "reg",
      [
        "query",
        "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths",
      ],
      { timeout: 3000, windowsHide: true }
    );
    for (const line of stdout.split(/\r?\n/)) {
      const m = line.match(/App Paths\\([^\\]+)\.exe$/i);
      const name = m?.[1]?.trim();
      if (name && !seen.has(name)) {
        seen.add(name);
        entries.push(makeAppEntry(name, line.trim(), "apps:windows-registry"));
      }
    }
  } catch {
    // Registry query unavailable
  }

  return entries;
}

export async function scanDesktopApps(
  platform: NodeJS.Platform = process.platform
): Promise<CapabilityEntry[]> {
  if (platform === "darwin") return scanMacApps();
  if (platform === "linux") return scanLinuxApps();
  if (platform === "win32") return scanWindowsApps();
  return [];
}
