import type { Tool } from "./types";
import { shell } from "./shell";
import { readFile, writeFile, editFile, grep } from "./files";
import { webSearch, webFetch } from "./web";
import { browser } from "./browser";
import { plan } from "./plan";
import { mcpTools } from "./mcp";

export const BUILTIN: Tool[] = [shell, readFile, writeFile, editFile, grep, webSearch, webFetch, browser, plan];

export async function allTools(): Promise<Tool[]> {
  return [...BUILTIN, ...(await mcpTools())];
}
