import type { CapabilityEntry } from "../schema";
import { discoverMcpConfigs } from "./mcp-configs";
import { probeMcpServer } from "./mcp-probe";
import { scanCliTools, type CliScanOptions } from "./cli-scanner";
import { scanDesktopApps } from "./apps-scanner";
import { scanAiProviders } from "./providers-scanner";

export interface ScanAllOptions {
  verifyProviders?: boolean;
  mcpTimeoutMs?: number;
  cli?: CliScanOptions;
}

export async function scanAll(
  options: ScanAllOptions = {}
): Promise<CapabilityEntry[]> {
  const mcpConfigs = await discoverMcpConfigs();

  const [mcpResults, cliEntries, appEntries, providerEntries] =
    await Promise.all([
      Promise.all(
        mcpConfigs.map((cfg) =>
          probeMcpServer(cfg, { timeoutMs: options.mcpTimeoutMs ?? 4000 })
        )
      ),
      scanCliTools(options.cli),
      scanDesktopApps(),
      scanAiProviders({ verify: options.verifyProviders ?? false }),
    ]);

  const combined: CapabilityEntry[] = [
    ...mcpResults.flat(),
    ...cliEntries,
    ...appEntries,
    ...providerEntries,
  ];

  const dedup = new Map<string, CapabilityEntry>();
  for (const entry of combined) {
    dedup.set(entry.id, entry);
  }
  return Array.from(dedup.values());
}

export * from "./mcp-configs";
export * from "./mcp-probe";
export * from "./cli-manifest";
export * from "./cli-scanner";
export * from "./apps-scanner";
export * from "./providers-scanner";
