import type { Tool } from "./types";
import { shell } from "./shell";
import { readFile, writeFile, editFile, undoEdit, grep } from "./files";
import { webSearch, webFetch } from "./web";
import { browser } from "./browser";
import { plan } from "./plan";
import { apiRequest } from "./api";
import { mcpTools } from "./mcp";

export const BUILTIN: Tool[] = [shell, readFile, writeFile, editFile, undoEdit, grep, webSearch, webFetch, browser, plan, apiRequest];

export async function allTools(): Promise<Tool[]> {
  return [...BUILTIN, ...(await mcpTools())];
}
