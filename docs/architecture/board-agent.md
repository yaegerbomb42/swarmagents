# Board-Agent chat API (v1)

Use the normal SwarmAgents session to call `/api/board-agent/chat`. Middleware sets `x-swarm-user` after authentication; clients cannot select an owner by supplying that header.

- `POST { "message": "Fix the docs" }` starts a conversation. Include `conversationId` in a later POST to continue it (for example, `"What's the status?"`). The request body is limited to 16 KiB and the message to 1–4000 characters.
- POST returns `{ reply, conversationId, taskIds, runIds }`. The ID arrays identify **new** tasks and accepted runs from that turn. A run may be queued, and accepting a run does not mean it succeeded. A `503` for missing BYOK configuration or `502` for a provider failure includes a human-readable `reply` on the same response shape.
- `GET` lists the caller's conversations, newest first, as `{ conversations: [{ id, title, updatedAt, messageCount }] }`. `GET ?conversationId=<id>` returns `{ conversation }` with messages and any task/run links. An unknown or other user's conversation returns `404`.

For a quick snapshot, send `{"message":"/digest"}` (or `"board digest"`). This is a read-only command and does not need a provider key. It shows open and actively claimed counts, the oldest review and blocked items, expired claims ready to reclaim, and recently board-approved tasks. A board approval is not evidence of a Git merge. Each section shows up to five items and counts any omitted work.

When a chat turn uses tools, the reply comes from their results, not from a model's description of what happened. A PR recorded on a task is a reported link; any text from a VM's final response is labeled as unverified run output.

The board is shared, exactly as with the existing SwarmBoard MCP endpoint. Conversations and VM run lookups are private to their caller. Chat can record tasks without dispatching them. For dispatched work, ask for the VM status or result in chat; VM outcomes do not automatically change a board task's status. VM starts use the existing approval and queue policy.

This release has no chat UI, completion push/SSE, or task refinement flow. Conversation files use the board's data directory; use a persistent `SWARM_HOME` in production.
