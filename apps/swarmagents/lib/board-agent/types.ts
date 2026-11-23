import type { VmMcpToolName } from "../mcp-types";

export interface BoardAgentMessage {
  role: "user" | "agent" | "tool";
  content: string;
  createdAt: number;
  taskId?: string;
  runId?: string;
}

export interface BoardAgentConversation {
  id: string;
  userId: string;
  title: string;
  messages: BoardAgentMessage[];
  createdAt: number;
  updatedAt: number;
}

export type BoardAgentToolName =
  | "create_board_task"
  | "list_board_tasks"
  | "get_board_task"
  | "get_run_status"
  | "get_board_digest"
  | VmMcpToolName;

export interface BoardAgentToolCall {
  tool: BoardAgentToolName;
  args: Record<string, unknown>;
}

export interface BoardAgentToolResult<T = unknown> {
  ok: boolean;
  summary: string;
  error?: string;
  data?: T;
}
