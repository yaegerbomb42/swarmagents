// Recorded `claude -p ... --output-format stream-json --verbose` transcript
// replayed by FakeVmDriver so local playtests exercise the real runtime
// pipeline (task -> runner -> telemetry -> SSE -> terminal) without a real
// Claude Code binary or network access.

export const FAKE_CLAUDE_SESSION_ID = "sess_fake_playtest";
export const FAKE_CLAUDE_MODEL = "claude-sonnet-5-5";
export const FAKE_CLAUDE_ASSISTANT_TEXT = "Smoke check complete — the sandbox is healthy.";

/**
 * Prompt marker that makes the fake claude emit a risky Bash tool call instead
 * of the benign smoke-check transcript. The e2e approval spec sends a prompt
 * containing this command so the runtime risk gate opens an approval card.
 */
export const FAKE_CLAUDE_APPROVAL_TRIGGER = "rm -rf /";
export const FAKE_CLAUDE_APPROVAL_ASSISTANT_TEXT = "Removing the sandbox root as requested.";

/** Prompt phrase that replays an ask_user call (the fake VM fakes the rendezvous). */
export const FAKE_CLAUDE_QUESTION_TRIGGER = "which engine";
export const FAKE_CLAUDE_QUESTION = "Which engine should the game use?";
export const FAKE_CLAUDE_QUESTION_OPTIONS = ["Godot", "Three.js"] as const;

/** Prompt phrase that replays a call aimed at the host filesystem. */
export const FAKE_CLAUDE_HOST_TARGET_TRIGGER = "read the host filesystem";
export const FAKE_CLAUDE_HOST_PATH = "/host/etc/passwd";

/**
 * Prompt phrase that replays a routine ask-classified command. Auto-approve
 * mode runs it without an approval card; only host-targeted and irreversible
 * external calls stay gated.
 */
export const FAKE_CLAUDE_AUTO_APPROVE_TRIGGER = "install flask";
export const FAKE_CLAUDE_AUTO_APPROVE_COMMAND = "pip install flask";
export const FAKE_CLAUDE_AUTO_APPROVE_ASSISTANT_TEXT = "Flask is installed — auto-approve let the package install run.";

export const FAKE_CLAUDE_TRANSCRIPT_LINES: readonly string[] = [
  JSON.stringify({
    type: "system",
    subtype: "init",
    cwd: "/workspace",
    session_id: FAKE_CLAUDE_SESSION_ID,
    model: FAKE_CLAUDE_MODEL,
  }),
  JSON.stringify({
    type: "assistant",
    message: {
      id: "msg_fake_1",
      role: "assistant",
      model: FAKE_CLAUDE_MODEL,
      content: [{ type: "text", text: "Running the end-to-end smoke check." }],
      usage: { input_tokens: 24, output_tokens: 8, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }),
  JSON.stringify({
    type: "assistant",
    message: {
      id: "msg_fake_2",
      role: "assistant",
      model: FAKE_CLAUDE_MODEL,
      content: [{ type: "tool_use", id: "toolu_fake_1", name: "Bash", input: { command: "uname -a" } }],
    },
  }),
  JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_fake_1",
          content: "Linux agent-vm-01 6.1.0-28-cloud-amd64 #1 SMP",
          is_error: false,
        },
      ],
    },
  }),
  JSON.stringify({
    type: "assistant",
    message: {
      id: "msg_fake_3",
      role: "assistant",
      model: FAKE_CLAUDE_MODEL,
      content: [{ type: "text", text: FAKE_CLAUDE_ASSISTANT_TEXT }],
      usage: { input_tokens: 48, output_tokens: 16, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }),
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: FAKE_CLAUDE_SESSION_ID,
    cost_usd: 0.001,
    duration_ms: 42,
    num_turns: 2,
  }),
];

export const FAKE_CLAUDE_TRANSCRIPT = `${FAKE_CLAUDE_TRANSCRIPT_LINES.join("\n")}\n`;

/**
 * Transcript replayed when the prompt asks the fake agent to run a destructive
 * root deletion. The `Bash` tool_use classifies as "ask", so the runtime pauses
 * on an approval gate instead of finishing immediately.
 */
export const FAKE_CLAUDE_APPROVAL_TRANSCRIPT_LINES: readonly string[] = [
  JSON.stringify({
    type: "system",
    subtype: "init",
    cwd: "/workspace",
    session_id: FAKE_CLAUDE_SESSION_ID,
    model: FAKE_CLAUDE_MODEL,
  }),
  JSON.stringify({
    type: "assistant",
    message: {
      id: "msg_fake_approval_1",
      role: "assistant",
      model: FAKE_CLAUDE_MODEL,
      content: [{ type: "text", text: FAKE_CLAUDE_APPROVAL_ASSISTANT_TEXT }],
      usage: { input_tokens: 24, output_tokens: 8, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }),
  JSON.stringify({
    type: "assistant",
    message: {
      id: "msg_fake_approval_2",
      role: "assistant",
      model: FAKE_CLAUDE_MODEL,
      content: [
        {
          type: "tool_use",
          id: "toolu_fake_approval_1",
          name: "Bash",
          input: { command: FAKE_CLAUDE_APPROVAL_TRIGGER },
        },
      ],
    },
  }),
  JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_fake_approval_1",
          content: "sandbox root cleanup complete",
          is_error: false,
        },
      ],
    },
  }),
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: FAKE_CLAUDE_SESSION_ID,
    cost_usd: 0.001,
    duration_ms: 42,
    num_turns: 2,
  }),
];

export const FAKE_CLAUDE_APPROVAL_TRANSCRIPT = `${FAKE_CLAUDE_APPROVAL_TRANSCRIPT_LINES.join("\n")}\n`;

/** Routine ask-classified call that auto-approve must run without a card. */
export const FAKE_CLAUDE_AUTO_APPROVE_TRANSCRIPT_LINES: readonly string[] = [
  JSON.stringify({
    type: "system",
    subtype: "init",
    cwd: "/workspace",
    session_id: FAKE_CLAUDE_SESSION_ID,
    model: FAKE_CLAUDE_MODEL,
  }),
  JSON.stringify({
    type: "assistant",
    message: {
      id: "msg_fake_auto_1",
      role: "assistant",
      model: FAKE_CLAUDE_MODEL,
      content: [{ type: "text", text: "Installing the dependency." }],
      usage: { input_tokens: 20, output_tokens: 6, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }),
  JSON.stringify({
    type: "assistant",
    message: {
      id: "msg_fake_auto_2",
      role: "assistant",
      model: FAKE_CLAUDE_MODEL,
      content: [
        {
          type: "tool_use",
          id: "toolu_fake_auto_1",
          name: "Bash",
          input: { command: FAKE_CLAUDE_AUTO_APPROVE_COMMAND },
        },
      ],
    },
  }),
  JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_fake_auto_1",
          content: "Successfully installed flask",
          is_error: false,
        },
      ],
    },
  }),
  JSON.stringify({
    type: "assistant",
    message: {
      id: "msg_fake_auto_3",
      role: "assistant",
      model: FAKE_CLAUDE_MODEL,
      content: [{ type: "text", text: FAKE_CLAUDE_AUTO_APPROVE_ASSISTANT_TEXT }],
    },
  }),
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: FAKE_CLAUDE_SESSION_ID,
    cost_usd: 0.001,
    duration_ms: 42,
    num_turns: 3,
  }),
];

// ---------------------------------------------------------------------------
// Long-term memory
// ---------------------------------------------------------------------------

/**
 * Prompt marker that makes the fake agent store a memory instead of running
 * the smoke check: the local playtest tells the agent "remember this
 * preference: ..." and the fake agent calls the memory MCP tool, exactly like
 * a real agent would.
 */
export const FAKE_CLAUDE_MEMORY_TRIGGER = "remember this preference";
/** What the fake agent says after it stored a memory. */
export const FAKE_CLAUDE_MEMORY_ASSISTANT_TEXT = "Saved to long-term memory — I will remember that.";
/** The tool the fake agent calls to store a memory. */
export const FAKE_CLAUDE_MEMORY_TOOL = "mcp__memory__memory_write";
/** The tool_use id of the fake memory call. */
export const FAKE_CLAUDE_MEMORY_TOOL_ID = "toolu_fake_memory_1";

/**
 * The fact the fake agent stores: everything after the trigger in the prompt.
 * Returns null when the prompt does not ask for a memory.
 */
export function memoryFactFromPrompt(prompt: string): string | null {
  const index = prompt.toLowerCase().indexOf(FAKE_CLAUDE_MEMORY_TRIGGER);
  if (index === -1) return null;
  const fact = prompt.slice(index + FAKE_CLAUDE_MEMORY_TRIGGER.length).replace(/^[\s:,-]+/, "").trim();
  return fact || null;
}

/**
 * The memory the fake agent recalls: the first line of the injected memory
 * block in the run's system prompt (the app injects the account's memories
 * there at the start of a run).
 */
export function recalledMemoryFromSystemPrompt(systemPrompt: string): string | null {
  const lines = systemPrompt.split("\n");
  let inBlock = false;
  for (const line of lines) {
    if (line.startsWith("Long-term memory for this account")) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    if (!line.startsWith("- ")) break;
    const fact = line.slice(2).replace(/\s*\[[^\]]*\]\s*$/, "").trim();
    if (fact) return fact;
  }
  return null;
}

/** The assistant line the fake agent emits when it recalls a memory. */
export function recalledMemoryAssistantText(fact: string): string {
  return `I remember: ${fact}`;
}

/**
 * Transcript replayed when the prompt asks a question the user must answer.
 * The fake VM driver writes the matching pending-question file and waits for
 * the harness answer before replaying the tool result, so the runtime's real
 * ask_user pause/resume path is exercised end to end.
 */
export const FAKE_CLAUDE_QUESTION_TRANSCRIPT_LINES: readonly string[] = [
  JSON.stringify({
    type: "system",
    subtype: "init",
    cwd: "/workspace",
    session_id: FAKE_CLAUDE_SESSION_ID,
    model: FAKE_CLAUDE_MODEL,
  }),
  JSON.stringify({
    type: "assistant",
    message: {
      id: "msg_fake_question_1",
      role: "assistant",
      model: FAKE_CLAUDE_MODEL,
      content: [{ type: "text", text: "One decision before I start building." }],
      usage: { input_tokens: 24, output_tokens: 8, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }),
  JSON.stringify({
    type: "assistant",
    message: {
      id: "msg_fake_question_2",
      role: "assistant",
      model: FAKE_CLAUDE_MODEL,
      content: [
        {
          type: "tool_use",
          id: "toolu_fake_question_1",
          name: "mcp__ask__ask_user",
          input: {
            question: FAKE_CLAUDE_QUESTION,
            options: [...FAKE_CLAUDE_QUESTION_OPTIONS],
            allow_free_text: true,
          },
        },
      ],
    },
  }),
  JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_fake_question_1",
          content: JSON.stringify({ answer: "Godot" }),
          is_error: false,
        },
      ],
    },
  }),
  JSON.stringify({
    type: "assistant",
    message: {
      id: "msg_fake_question_3",
      role: "assistant",
      model: FAKE_CLAUDE_MODEL,
      content: [{ type: "text", text: "Building the game with the engine you chose." }],
    },
  }),
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: FAKE_CLAUDE_SESSION_ID,
    cost_usd: 0.001,
    duration_ms: 42,
    num_turns: 3,
  }),
];

/** Transcript replayed when the prompt asks the agent to touch the host. */
export const FAKE_CLAUDE_HOST_TARGET_TRANSCRIPT_LINES: readonly string[] = [
  JSON.stringify({
    type: "system",
    subtype: "init",
    cwd: "/workspace",
    session_id: FAKE_CLAUDE_SESSION_ID,
    model: FAKE_CLAUDE_MODEL,
  }),
  JSON.stringify({
    type: "assistant",
    message: {
      id: "msg_fake_host_1",
      role: "assistant",
      model: FAKE_CLAUDE_MODEL,
      content: [{ type: "text", text: "Reading a file outside the VM." }],
    },
  }),
  JSON.stringify({
    type: "assistant",
    message: {
      id: "msg_fake_host_2",
      role: "assistant",
      model: FAKE_CLAUDE_MODEL,
      content: [
        { type: "tool_use", id: "toolu_fake_host_1", name: "Read", input: { file_path: FAKE_CLAUDE_HOST_PATH } },
      ],
    },
  }),
  JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_fake_host_1",
          content: "root:x:0:0:root:/root:/bin/bash",
          is_error: false,
        },
      ],
    },
  }),
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: FAKE_CLAUDE_SESSION_ID,
    cost_usd: 0.001,
    duration_ms: 42,
    num_turns: 2,
  }),
];
