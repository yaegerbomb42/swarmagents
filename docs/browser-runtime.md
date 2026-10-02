# The browser runtime

One isolated Chromium per task, a live view of it in the app, and tests that keep the promises.

## Pieces

| Layer | File | Responsibility |
| --- | --- | --- |
| Runtime | `lib/browser/runtime.ts` | Launch/limit/record/watch CDP screencast; owns every live session |
| Input | `lib/browser/screencast.ts` | Replay the user's mouse/keyboard into the page over CDP |
| Tool | `lib/tools/browser.ts` | Thin layer: turns model actions into page ops + the observation it reasons from |
| Viewer | `components/BrowserLive.tsx` | URL bar, tabs, frames, take-over/pause/stop, downloads |
| Transport | `app/api/browser/{stream,control}/route.ts` | Auth-gated frames + control, keyed to a task the caller owns |
| Tests | `tests/browser-*.mjs` | Runtime, viewer, security, public-site, capture |

## Isolation and limits

Every task key (the session id; a sub-agent gets its own) maps to a `BrowserSession`:

- its own **profile directory** `SWARM_HOME/<user>/browsers/<key>` (no shared cookies or logins), and
- its own **downloads** folder, `session.useWorkspace(cwd)` routes them to the task's `<cwd>/downloads`.

Hard caps, all overridable with `SWARM_BROWSER_*`:

| Env | Default | Meaning |
| --- | --- | --- |
| `SWARM_BROWSER_MAX_TABS` | 12 | tabs per session |
| `SWARM_BROWSER_MAX_DOWNLOAD_BYTES` | 512 MB | total downloaded per session |
| `SWARM_BROWSER_MAX_FILE_BYTES` | 256 MB | any single file |
| `SWARM_BROWSER_MAX_SESSION_MS` | 60 min | wall clock (reaped to 0 = off) |
| `SWARM_BROWSER_IDLE_MS` | 15 min | idle before the browser closes |
| `SWARM_BROWSER_MAX_LIVE` | 4 | live browsers before the LRU one is evicted |
| `SWARM_BROWSER_HEADLESS` / `_NO_SANDBOX` / `_CHROME_PATH` | — | how Chromium runs (the container sets these) |
| `SWARM_BROWSER_BLOCK_ORIGINS` | empty | extra origins the agent may not request |

Downloads are filtered by extension and by size, and a refused download is reported back to the model.

## Limits the deploy lane owns

Private ranges, the tailnet and cloud metadata are dropped by the egress firewall
(`deploy/swarmagents-egress.sh`), not by this runtime — the runtime builds on that. Inside the browser
we add: no `file://` reads of the server disk, and no requests to `SWARM_BROWSER_BLOCK_ORIGINS`.

## Frames and control

- Frames come from CDP `Page.startScreencast` (JPEG q60, one frame per paint).
- They reach the app as server-sent events on `GET /api/browser/stream?session=…`, throttled to ~12 fps.
- Measured delay locally is ~3 ms; the test fails if it exceeds **500 ms**.
- `POST /api/browser/control` carries `takeOver`/`handBack`/`{paused}`/`{stop}` and the raw
  mouse/keyboard events of whoever holds control; input is refused (409) while the agent drives.

## Why not noVNC / a WebSocket

`next start` exposes no upgrade hook, the app has no `ws` dependency, and the deploy lane owns the
container's CMD — so a WebSocket server would mean a custom server or a sidecar, for no gain here. CDP
screencast over an authenticated HTTP stream reuses the app's existing live pattern (sessions, runtime),
passes the same `scoped()` auth, and measured ~3 ms locally. If a real WebSocket is ever wanted, it goes
behind the same `scoped()` gate.

## Auth is not optional

Both viewer routes are wrapped in `scoped()`; the task is resolved from the caller's own store, so a
viewer can only stream or drive a browser for a task they own. In server mode an anonymous request gets
401 — the security test asserts this, including a forged session cookie.

## Pause, stop, step

- **Take over / Hand back** — the user holds the mouse and keyboard; the agent's next action waits
  (`whenAgentTurn()`), so logins, 2FA and captchas are theirs to finish.
- **Pause / Resume** — the agent stops before its next action and resumes on Resume.
- **Stop** — closes the browser and tells every viewer.
- (Step-by-step stepping is the next slice; the current controls are take-over, pause, stop.)

## Recording

At ~1 keyframe/s plus every event (downloads, tabs, control changes) a session is recorded in memory
(bounded) and appended to `recording.jsonl` when it closes. `npm run test:browser:capture` writes a
self-contained `docs/ui/browser/recording.html` player next to a real recording.