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

export interface BoardAgentToolCall {
  tool: "create_board_task" | "list_board_tasks" | "get_board_task" | "get_run_status" | "get_board_digest";
  args: Record<string, unknown>;
}

export interface BoardAgentToolResult<T = unknown> {
  ok: boolean;
  summary: string;
  data?: T;
}
