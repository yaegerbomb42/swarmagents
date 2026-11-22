import { z } from "zod";
import type { McpToolDefinition, VmMcpToolName } from "../mcp-types";

export const VM_MAX_WAIT_MS = 30_000;
export const VM_RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const vmExecInputSchema = z.object({
  cmd: z
    .union([
      z.string().min(1, "cmd is required."),
      z.array(z.string().min(1, "cmd entries must be non-empty strings.")).min(1, "cmd is required."),
    ])
    .describe("Shell command string (executed via bash -lc in /workspace) or non-empty argv array."),
  waitMs: z
    .number()
    .int()
    .min(0)
    .max(VM_MAX_WAIT_MS)
    .optional()
    .describe("Optional milliseconds (0-30000) to wait for command output and completion."),
});

export const vmReadOutputInputSchema = z.object({
  runId: z
    .string()
    .regex(VM_RUN_ID_RE, "runId must match ^[A-Za-z0-9_-]{1,64}$.")
    .describe("Run ID returned by vm_exec or an agent VM run owned by the caller."),
  fromSeq: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Only return telemetry output with sequence number strictly greater than fromSeq (default 0)."),
  waitMs: z
    .number()
    .int()
    .min(0)
    .max(VM_MAX_WAIT_MS)
    .optional()
    .describe("Optional milliseconds (0-30000) to wait for the run to settle if still in progress."),
});

export const vmReadFileInputSchema = z.object({
  path: z
    .string()
    .min(1, "path is required.")
    .describe("Path inside /workspace (absolute like /workspace/foo.ts or relative like foo.ts)."),
});

export const vmWriteFileInputSchema = z.object({
  path: z
    .string()
    .min(1, "path is required.")
    .describe("Target file path inside /workspace (absolute like /workspace/foo.ts or relative like foo.ts)."),
  content: z
    .string()
    .describe("UTF-8 text content to write to the file."),
});

export const vmListWorkspaceInputSchema = z.object({
  path: z
    .string()
    .optional()
    .describe("Directory path inside /workspace to list (defaults to /workspace)."),
});

export const vmScreenshotInputSchema = z.object({});

function toToolInputSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

export const VM_MCP_TOOL_DEFINITIONS: readonly McpToolDefinition[] = [
  {
    name: "vm_exec",
    description:
      "Execute a shell command or argv array inside the caller's isolated /workspace VM. High-risk or privileged commands are rejected. Returns runId (and captured output when waitMs is given).",
    inputSchema: toToolInputSchema(vmExecInputSchema),
  },
  {
    name: "vm_read_output",
    description:
      "Read buffered or persisted telemetry output (stdout/stderr, status, exit code) for a VM run owned by the caller.",
    inputSchema: toToolInputSchema(vmReadOutputInputSchema),
  },
  {
    name: "vm_read_file",
    description:
      "Read a file inside the caller's /workspace volume (capped at 1 MiB; binary files report metadata without inline content).",
    inputSchema: toToolInputSchema(vmReadFileInputSchema),
  },
  {
    name: "vm_write_file",
    description:
      "Write UTF-8 text content to a file inside the caller's /workspace volume (creating parent directories as needed).",
    inputSchema: toToolInputSchema(vmWriteFileInputSchema),
  },
  {
    name: "vm_list_workspace",
    description:
      "List entries in a directory inside the caller's /workspace volume (defaults to /workspace).",
    inputSchema: toToolInputSchema(vmListWorkspaceInputSchema),
  },
  {
    name: "vm_screenshot",
    description:
      "Capture a PNG screenshot of the caller's running VM desktop (:1) and return base64-encoded image data.",
    inputSchema: toToolInputSchema(vmScreenshotInputSchema),
  },
];

const VM_TOOL_SET = new Set<string>(VM_MCP_TOOL_DEFINITIONS.map((tool) => tool.name));

export function isVmMcpTool(name: string): name is VmMcpToolName {
  return VM_TOOL_SET.has(name);
}
