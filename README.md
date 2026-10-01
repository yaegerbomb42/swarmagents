# Swarm

One chat bar, one agent, every tool. Everything the agent thinks and does streams into the main view.

```
./bin/swarm        # builds if needed, serves http://127.0.0.1:3777 and opens it
npm run dev        # hot-reload development
```

**Settings** holds only LLM provider keys. The agent uses the first enabled provider and fails over down
the list. Rate limits are learned from real 429s (requests and tokens per minute at the moment of the
throttle), and later requests are paced under that ceiling. Learned limits show next to each provider.

**Tools:** shell (streaming, persistent cwd, background jobs), read/write/edit files (paged, so any size;
images, PDFs and Office docs supported), ripgrep search, web search and fetch, a real visible Chrome with
persistent logins, a live plan, and every MCP connector configured in `~/.swarmagents/mcp.json`,
`~/.claude.json` or Claude Desktop.

**Context:** at 75% of the model's window, old tool outputs and screenshots are trimmed first. If that isn't
enough, earlier work is summarized into a handoff. Both appear in the timeline, and the summary is readable.
Messages sent while the agent works are injected at its next step. Esc stops it.

Data lives in `~/.swarmagents` (keys mode 0600). The server binds to 127.0.0.1 and rejects non-local
hosts and origins, because the agent has full control of this machine.
