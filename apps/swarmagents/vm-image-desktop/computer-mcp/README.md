# SwarmAgents computer-use MCP server

A small stdio MCP server that gives the Claude Code agent inside the desktop
VM real control of the on-screen desktop (X display `:1` by default):

| Tool | What it does |
| --- | --- |
| `screenshot` | Capture the desktop as PNG (downscaled to ≤1280 px wide) |
| `describe_screen(includeOcr?, includeUi?, maxItems?)` | Text-only view: geometry, windows, AT-SPI2 widgets and OCR text targets with click centers |
| `inspect_ui(app?, query?, role?, maxItems?)` | AT-SPI2 accessibility tree: widget role, name, states (focused/disabled/checked/selected/expanded) and `click(x, y)` center |
| `click(x, y, button?)` | Move the pointer and click (1 left, 2 middle, 3 right, 4–7 wheel) |
| `double_click(x, y, button?)` | Double-click |
| `move(x, y)` | Move the pointer |
| `drag(x1, y1, x2, y2)` | Left-button drag |
| `type(text)` | Type text (newlines press Return) |
| `key(combo)` | Press a key combo, e.g. `ctrl+l`, `Return` |
| `scroll(dx, dy)` | Scroll by wheel steps (dy>0 down, dx>0 right) |
| `open_app(name)` | Open `browser` / `terminal` / `files` |
| `wait(ms)` | Sleep |

Transport is **stdio only** — there is no network listener. The server is
spawned by the role MCP wiring in the harness as
`node /opt/swarm/computer-mcp/server.mjs`.

## Security

- Every input tool is implemented with xdotool via **argv arrays** — never
  shell strings — so no argument can be interpreted as a command (see
  `validate.mjs`, the single source of truth for argument validation).
- `open_app` only launches apps on a fixed allowlist.
- `inspect_ui` filters are charset- and length-limited and passed to the
  helper as separate argv elements. The helper reads accessible names, roles,
  states and extents only — never text contents — so typed values (including
  password fields) are not returned.
- Coordinates, button numbers, deltas and wait times are validated to strict
  integer ranges; text/key combos are length- and charset-limited.

## Files

- `server.mjs` — the MCP server (stdio transport, tool registration).
- `validate.mjs` — shared argument validation + argv construction + summary
  strings (also imported by the harness's risk/telemetry layer for tests).
- `atspi_dump.py` — AT-SPI2 tree walker (python3-pyatspi) behind `inspect_ui`
  and the widget section of `describe_screen`. Bounded by node, depth and
  time caps; prints one JSON object. Finds the accessibility bus through the
  `AT_SPI_BUS` X root-window property published by `at-spi-bus-launcher`
  (started in the XFCE session, see `files/supervisord.conf`).
- `package.json` — dependencies (`@modelcontextprotocol/sdk`).

Run locally: `npm install && npm start` (then talk to it over stdio, e.g.
with any MCP client).
