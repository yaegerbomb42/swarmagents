import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppendField, AgentEvent, Attachment, Block, ContextInfo, Msg, PlanItem, ProviderConfig, SessionMeta, StreamOp } from "./types";
import { archiveEvents, getMeta, listSessions, loadEvents, loadHistory, newId, saveEvents, saveHistory, saveMeta, UPLOADS_DIR } from "./store";
import { contextWindow, estimateTokens, routeTurn, setLearnedContext, activeProviders } from "./router";
import { ProviderError } from "./providers/types";
import { allTools } from "./tools";
import { browserTargetLabel } from "./tools/browser";
import type { Tool } from "./tools/types";
import { setAgentAdapter } from "./runtime/resume";
import { riskOf, actionHash, describe, type Risk } from "./runtime/approvals";
import { takeApproval, isDenied } from "./runtime/store";
import { subagentTool } from "./subagents";

const READ_ONLY = new Set(["read_file", "search", "web_search", "web_fetch"]);

/** Set by the task runtime while a task runs, so the tool loop can gate risky actions for that task.
 *  Absent for ordinary chat, which the user drives directly and can stop at any moment. */
const taskGuards = new Map<string, { taskId: string }>();

function setTaskGuard(sessionId: string, taskId: string): void {
  taskGuards.set(sessionId, { taskId });
}
function clearTaskGuard(sessionId: string): void {
  taskGuards.delete(sessionId);
}
export { setTaskGuard, clearTaskGuard };
/** Live events kept in memory and in the snapshot; past ARCHIVE_AT the oldest settled ones are archived. */
const KEEP_EVENTS = 1500;
const ARCHIVE_AT = 2500;
/** Identical tool calls in a row before the agent is told it is looping, and before the run is stopped. */
const LOOP_WARN = 5;
const LOOP_STOP = 10;
/** Times the agent is sent back to an unfinished plan without making progress before we accept its stop. */
const MAX_PLAN_NUDGES = 2;

function systemPrompt(cwd: string, tools: Tool[]) {
  const mcp = [...new Set(tools.filter((t) => t.spec.name.startsWith("mcp__")).map((t) => t.spec.name.split("__")[1]))];
  return `You are the user's personal agent, running locally on their Mac with full access: shell, filesystem, a real Chrome browser, the web${mcp.length ? `, and connectors (${mcp.join(", ")})` : ""}. Everything you think and do is shown to the user live.

How you work:
- Infer intent. Figure out what the user actually wants done and do it end to end. Don't ask for clarification unless a wrong guess would be costly or irreversible; otherwise pick the most sensible interpretation, act, and say what you assumed.
- Move fast. Prefer the most direct path. Batch independent read-only lookups in one turn (they run in parallel). Don't narrate what you're about to do at length; just do it.
- Verify. After changing things, check they worked (run the test, reload the page, re-read the file). Don't claim success you haven't observed.
- For multi-step work, keep a short plan with the plan tool and update it as you go.
- When work splits into independent pieces (several things to research, separate modules to build or investigate), hand them to parallel sub-agents with the subagent tool, then integrate and verify their reports yourself.
- Be careful with destructive, irreversible or outward-facing actions (deleting data, force-pushing, sending messages/emails, purchases): confirm with the user first unless they already clearly asked for exactly that.
- Large inputs: read files in pages, grep before reading, and save big intermediate results to disk instead of holding them in context.
- When done, reply with a brief, direct summary of the outcome. Use markdown. No filler.

Environment: macOS, home ${os.homedir()}, current directory ${cwd}, user uploads in ${UPLOADS_DIR}. Date ${new Date().toDateString()}.`;
}

// ---- Session runtime (kept on globalThis so dev hot-reloads don't orphan running agents) ----

class Session {
  events: AgentEvent[];
  history: Msg[];
  meta: SessionMeta;
  running = false;
  abort: AbortController | null = null;
  subs = new Set<(op: StreamOp) => void>();
  inbox: { text: string; attachments: Attachment[]; resumeNote?: string }[] = [];
  context: ContextInfo = { tokens: 0, window: 200_000 };
  /** Set when a run stopped because a risky tool needs the user's decision. Read by the task adapter. */
  pendingApproval: { message: string; risk: Risk; token: string } | null = null;
  /** Tokens the provider counts beyond our history estimate (system prompt, tool schemas, estimate error). */
  private overhead = 0;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(meta: SessionMeta) {
    this.meta = meta;
    this.events = loadEvents(meta.id);
    this.history = loadHistory(meta.id);
    // Restore messages that were sent but never saved into history, before anything below can flush. Their
    // timeline card may also have missed the debounced save, so re-add any that is absent.
    for (const m of meta.pendingInput ?? []) {
      this.inbox.push({ ...m });
      if (!this.events.some((e) => e.type === "user" && e.text === m.text)) this.events.push({ id: newId(), ts: Date.now(), type: "user", text: m.text, attachments: m.attachments });
    }
    let repaired = false;
    // A tool can have taken effect before a crash prevented its result from being checkpointed.
    // Close every dangling tool call with an explicit unknown outcome; never replay it blindly.
    for (let i = 0; i < this.history.length; i++) {
      const message = this.history[i];
      if (message.role !== "assistant") continue;
      const calls = message.blocks.filter((b): b is Extract<Block, { type: "tool_call" }> => b.type === "tool_call");
      if (!calls.length) continue;

      const next = this.history[i + 1];
      const resultIds = new Set(next?.role === "user" ? next.blocks.filter((b) => b.type === "tool_result").map((b) => b.id) : []);
      const missing = calls.filter((c) => !resultIds.has(c.id));
      if (!missing.length) continue;

      const results: Block[] = missing.map((c) => ({
        type: "tool_result",
        id: c.id,
        content: `[interrupted; outcome unknown] The ${c.name} tool may have completed partially or fully before the process stopped. Inspect the current state before retrying this action.`,
        isError: true,
      }));
      if (next?.role === "user") next.blocks.unshift(...results);
      else this.history.splice(i + 1, 0, { role: "user", blocks: results });
      repaired = true;
    }

    // Settle unfinished cards. A running tool is an uncertain side effect, not an ordinary failure.
    for (const e of this.events) {
      if (e.type === "tool" && (e.status === "running" || e.status === "streaming")) {
        Object.assign(e, {
          status: "error",
          output: `${e.output ?? ""}${e.output ? "\n" : ""}[interrupted; outcome unknown] This tool may have completed partially or fully. Inspect the current state before retrying.`,
        });
        repaired = true;
      }
      if ("done" in e && e.done === false) {
        e.done = true;
        repaired = true;
      }
    }
    if (repaired) {
      this.events.push({
        id: newId(),
        ts: Date.now(),
        type: "notice",
        level: "warn",
        text: "This task was interrupted. Any tool marked with an unknown outcome may have completed partially or fully; inspect the current state before retrying it.",
      });
      this.flush();
    }
    this.context = { tokens: estimateTokens(this.history), window: contextWindow(activeProviders()[0]) };
  }

  emit(op: StreamOp) {
    for (const s of this.subs) s(op);
  }

  add<T extends AgentEvent>(e: Omit<T, "id" | "ts">): T {
    const ev = { id: newId(), ts: Date.now(), ...e } as T;
    this.events.push(ev);
    this.emit({ op: "add", event: ev });
    this.scheduleSave();
    return ev;
  }

  patch(ev: AgentEvent, patch: Partial<AgentEvent>, append?: { field: AppendField; value: string }) {
    Object.assign(ev, patch);
    if (append) (ev as unknown as Record<string, string>)[append.field] = ((ev as unknown as Record<string, string>)[append.field] ?? "") + append.value;
    this.emit({ op: "patch", id: ev.id, patch, append });
    this.scheduleSave();
  }

  remove(ev: AgentEvent) {
    this.events = this.events.filter((e) => e !== ev);
    this.emit({ op: "patch", id: ev.id, patch: { hidden: true } as Partial<AgentEvent> });
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 1500);
  }

  flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.archiveOld();
    saveEvents(this.meta.id, this.events);
    saveHistory(this.meta.id, this.history);
    // Drained messages are now in the saved history; only what is still queued stays pending.
    this.meta.pendingInput = this.inbox.filter((m) => !m.resumeNote).map(({ text, attachments }) => ({ text, attachments }));
    this.meta.updatedAt = Date.now();
    saveMeta(this.meta);
  }

  private archiveOld() {
    if (this.events.length <= ARCHIVE_AT) return;
    let cut = this.events.length - KEEP_EVENTS;
    // Never archive something still streaming or running; it must stay patchable.
    const open = this.events.findIndex((e) => ("done" in e && e.done === false) || (e.type === "tool" && (e.status === "running" || e.status === "streaming")));
    if (open >= 0) cut = Math.min(cut, open);
    if (cut <= 0) return;
    // Archive first: a crash between the two writes duplicates a few events rather than losing them.
    archiveEvents(this.meta.id, this.events.slice(0, cut));
    this.events = this.events.slice(cut);
    this.meta.archivedEvents = (this.meta.archivedEvents ?? 0) + cut;
  }

  setRunning(r: boolean) {
    this.running = r;
    this.emit({ op: "running", running: r });
    if (!r && !this.inbox.length) for (const f of this.idleWaiters.splice(0)) f();
  }

  private idleWaiters: (() => void)[] = [];

  /** Resolves once the session has no run in progress and nothing queued. */
  whenIdle(): Promise<void> {
    if (!this.running && !this.inbox.length) return Promise.resolve();
    return new Promise((res) => this.idleWaiters.push(res));
  }

  private setActive(a: boolean) {
    if (!!this.meta.active === a) return;
    this.meta.active = a;
    saveMeta(this.meta);
  }

  /** Continue a run that was cut off by a crash or restart. */
  resume() {
    if (this.running) return;
    this.repairHistory("[interrupted: the agent process restarted while this was running]");
    this.add({ type: "notice", level: "info", text: "Resumed after a restart. Interrupted tool calls were cancelled; the agent will re-check state and continue." } as AgentEvent);
    this.inbox.push({
      text: "",
      attachments: [],
      resumeNote: "[Automatic note, not from the user] The agent process restarted mid-task. Any tool calls in flight were interrupted and may have partially run. Re-check the current state (files, processes, browser) before continuing, then carry on with the task.",
    });
    void this.loop();
  }

  setContext(tokens: number, p?: ProviderConfig) {
    this.context = { tokens, window: contextWindow(p ?? activeProviders()[0]), provider: p?.label, model: p?.model };
    this.emit({ op: "context", context: this.context });
  }

  // ---- Input ----

  send(text: string, attachments: Attachment[]) {
    if (this.meta.title === "New task" && text.trim()) {
      this.meta.title = text.trim().replace(/\s+/g, " ").slice(0, 70);
      saveMeta(this.meta);
    }
    this.add({ type: "user", text, attachments } as AgentEvent);
    this.inbox.push({ text, attachments });
    // Durable before anything else happens: cleared by flush() once history containing it is on disk.
    this.meta.pendingInput = [...(this.meta.pendingInput ?? []), { text, attachments }];
    saveMeta(this.meta);
    if (!this.running) void this.loop();
  }

  stop() {
    this.abort?.abort();
  }

  private drainInbox(): Block[] {
    const blocks: Block[] = [];
    const items = this.inbox.splice(0);
    for (const [i, m] of items.entries()) {
      if (this.running && i === 0 && this.history.length && this.history.at(-1)?.role === "user")
        blocks.push({ type: "text", text: "[The user sent this while you were working. Take it into account now.]" });
      if (m.resumeNote) blocks.push({ type: "text", text: m.resumeNote });
      for (const a of m.attachments) blocks.push(...attachmentBlocks(a));
      if (m.text) blocks.push({ type: "text", text: m.text });
    }
    return blocks;
  }

  // ---- The agent loop ----

  async loop() {
    this.setRunning(true);
    this.abort = new AbortController();
    const signal = this.abort.signal;
    let tools: Tool[] = [];
    try {
      tools = await allTools();
      tools.push(subagentTool(tools));
    } catch (e) {
      this.add({ type: "notice", level: "warn", text: `Some connectors failed to load: ${(e as Error).message}` } as AgentEvent);
    }
    const toolMap = new Map(tools.map((t) => [t.spec.name, t]));
    const planEv = { current: null as AgentEvent | null };
    this.setActive(true);
    let stopReason: "done" | "user" | "error" = "done";
    let lastSig = "";
    let repeats = 0;
    let nudges = 0;
    let doneAtNudge = -1;

    try {
      this.pushUser(this.drainInbox());
      // No step cap: a long task may take thousands of steps. Loops are caught by the repetition check below.
      for (;;) {
        await this.maybeCompact(signal, false);
        const turn = await this.runTurn(tools, signal);
        this.history.push({ role: "assistant", blocks: turn.blocks });
        this.flush();

        const calls = turn.blocks.filter((b): b is Extract<Block, { type: "tool_call" }> => b.type === "tool_call");
        if (!calls.length) {
          if (turn.stop === "max_tokens") {
            this.history.push({ role: "user", blocks: [{ type: "text", text: "Continue exactly where you left off." }] });
            continue;
          }
          if (this.inbox.length) {
            this.pushUser(this.drainInbox());
            continue;
          }
          // Hold the agent to its own plan: stopping with open steps is usually premature on long tasks.
          const open = (this.meta.plan ?? []).filter((i) => i.status !== "done");
          const done = (this.meta.plan ?? []).length - open.length;
          if (turn.stop === "end" && open.length && planEv.current) {
            if (done > doneAtNudge) nudges = 0;
            if (nudges < MAX_PLAN_NUDGES) {
              nudges++;
              doneAtNudge = done;
              this.add({ type: "notice", level: "info", text: `Plan has ${open.length} open step${open.length > 1 ? "s" : ""}; asking the agent to continue.` } as AgentEvent);
              this.history.push({
                role: "user",
                blocks: [
                  {
                    type: "text",
                    text: `[Automatic check, not from the user] Your plan still has open steps:\n${open.map((i) => `- ${i.text}`).join("\n")}\nIf they are still needed, keep working on them now. If they are finished or no longer needed, update the plan to reflect that. If you are genuinely blocked on the user, say exactly what you need and stop.`,
                  },
                ],
              });
              continue;
            }
          }
          break;
        }

        const sig = JSON.stringify(calls.map((c) => [c.name, c.input]));
        repeats = sig === lastSig ? repeats + 1 : 1;
        lastSig = sig;
        if (repeats >= LOOP_STOP) {
          this.history.push({ role: "user", blocks: calls.map((c) => ({ type: "tool_result" as const, id: c.id, content: "[not run: identical call repeated too many times]", isError: true })) });
          this.add({ type: "notice", level: "warn", text: `Stopped: the agent repeated the same ${calls[0].name} call ${repeats} times in a row. Send a message to steer it.` } as AgentEvent);
          break;
        }

        const results = await this.runTools(calls, toolMap, signal, planEv);
        // A risky action was intercepted: keep its result in history (so the model knows the action is
        // pending) but stop the run so the runtime can block the task and ask the user.
        if (this.pendingApproval) {
          this.history.push({ role: "user", blocks: [...results, ...this.drainInbox()] });
          this.flush();
          break;
        }
        const warn: Block[] =
          repeats >= LOOP_WARN ? [{ type: "text", text: `[Automatic check, not from the user] You have made this exact call ${repeats} times in a row. If you are deliberately polling, put a longer sleep in the command itself; otherwise this is not making progress, so change approach.` }] : [];
        this.history.push({ role: "user", blocks: [...results, ...warn, ...this.drainInbox()] });
        this.flush();
      }
    } catch (e) {
      const err = e as ProviderError;
      stopReason = err.kind === "aborted" || signal.aborted ? "user" : "error";
      if (stopReason === "user") {
        this.add({ type: "notice", level: "info", text: "Stopped." } as AgentEvent);
        this.repairHistory();
      } else {
        this.add({ type: "notice", level: "error", text: err.message || String(e) } as AgentEvent);
        this.repairHistory();
      }
    } finally {
      for (const ev of this.events) if ("done" in ev && ev.done === false) this.patch(ev, { done: true } as Partial<AgentEvent>);
      this.abort = null;
      // Only a clean finish, an error or a user stop clears this; a crash leaves it set so boot resumes the run.
      if (!this.inbox.length || stopReason !== "done") this.setActive(false);
      this.flush();
      this.setRunning(false);
      if (this.inbox.length) void this.loop();
    }
  }

  private pushUser(blocks: Block[]) {
    const last = this.history.at(-1);
    if (last?.role === "user") last.blocks.push(...blocks);
    else this.history.push({ role: "user", blocks });
  }

  /** Keep history valid for the next turn after an interruption: every tool_call needs a result. */
  private repairHistory(note = "[interrupted by user]") {
    const last = this.history.at(-1);
    if (last?.role === "assistant") {
      const calls = last.blocks.filter((b) => b.type === "tool_call") as Extract<Block, { type: "tool_call" }>[];
      if (calls.length) this.history.push({ role: "user", blocks: calls.map((c) => ({ type: "tool_result", id: c.id, content: note, isError: true })) });
    }
    if (last?.role === "user" && !last.blocks.length) this.history.pop();
  }

  private async runTurn(tools: Tool[], signal: AbortSignal, compactRetry = true): ReturnType<typeof routeTurn> {
    let thinking: AgentEvent | null = null;
    let text: AgentEvent | null = null;
    const toolEvs = new Map<string, AgentEvent>();
    const attemptEvents: AgentEvent[] = [];
    // Thinking often arrives as one summarized burst at the end, so time it from when the request went out.
    let sentAt = Date.now();
    const endBlocks = () => {
      if (thinking) this.patch(thinking, { done: true, endTs: Date.now() } as Partial<AgentEvent>);
      if (text) this.patch(text, { done: true } as Partial<AgentEvent>);
      thinking = text = null;
    };
    try {
      const r = await routeTurn(
        { system: systemPrompt(this.meta.cwd, tools), messages: this.history, tools: tools.map((t) => t.spec), signal },
        {
          onThinking: (d) => {
            if (!thinking) attemptEvents.push((thinking = this.add({ type: "thinking", text: "", done: false, ts: sentAt } as AgentEvent)));
            this.patch(thinking, {}, { field: "text", value: d });
          },
          onText: (d) => {
            if (thinking) endBlocks();
            if (!text) attemptEvents.push((text = this.add({ type: "text", text: "", done: false } as AgentEvent)));
            this.patch(text, {}, { field: "text", value: d });
          },
          onToolStart: (id, name) => {
            endBlocks();
            const ev = this.add({ type: "tool", name, input: {}, inputPreview: "", status: "streaming" } as AgentEvent);
            attemptEvents.push(ev);
            toolEvs.set(id, ev);
          },
          onToolInput: (id, partial) => {
            const ev = toolEvs.get(id);
            if (ev) this.patch(ev, {}, { field: "inputPreview", value: partial });
          },
          onBlockEnd: endBlocks,
        },
        {
          onNotice: (level, t) => this.add({ type: "notice", level, text: t } as AgentEvent),
          onAttempt: () => {
            // Drop partial output from a failed attempt so the UI shows one clean turn.
            for (const ev of attemptEvents.splice(0)) this.remove(ev);
            toolEvs.clear();
            thinking = text = null;
            sentAt = Date.now();
          },
        },
      );
      endBlocks();
      // Bind tool call ids to their UI cards.
      for (const b of r.blocks) if (b.type === "tool_call") {
        const ev = toolEvs.get(b.id) ?? [...toolEvs.values()].find((e) => (e as { name: string }).name === b.name && !(e as { bound?: boolean }).bound);
        if (ev) {
          (ev as unknown as { bound: boolean }).bound = true;
          toolEvs.delete(b.id);
          toolEvs.set(b.id, ev);
          this.patch(ev, { input: b.input, status: "running" } as Partial<AgentEvent>);
        }
      }
      this.turnToolEvents = toolEvs;
      this.overhead = Math.max(0, r.usage.input - estimateTokens(this.history));
      this.add({ type: "turn", provider: r.provider.label, model: r.provider.model, inputTokens: r.usage.input, outputTokens: r.usage.output, cachedTokens: r.usage.cached, stop: r.stop } as AgentEvent);
      this.setContext(r.usage.input + r.usage.output, r.provider);
      return r;
    } catch (e) {
      endBlocks();
      if (e instanceof ProviderError && e.kind === "context" && compactRetry) {
        const p = activeProviders()[0];
        if (p && this.context.tokens) setLearnedContext(p.id, Math.floor(this.context.tokens * 0.95));
        await this.maybeCompact(signal, true, "The model rejected the request as too long.");
        return this.runTurn(tools, signal, false);
      }
      throw e;
    }
  }

  private turnToolEvents = new Map<string, AgentEvent>();

  /**
   * Classify this call against the approval gate for the current task run.
   *  - "run"    ordinary call, or an action the user already approved (grant consumed here)
   *  - "ask"    destructive/outward with no grant: park the run for a decision
   *  - "denied" the user already refused this exact action for this task
   * Only applies to task runs: interactive chat is user-driven and can be stopped at any moment.
   */
  private gate(name: string, input: Record<string, unknown>): "run" | "ask" | "denied" {
    const guard = taskGuards.get(this.meta.id);
    if (!guard) return "run";
    const risk = riskOf(name, input, name === "browser" ? browserTargetLabel(input) : undefined);
    if (!risk) return "run";
    const hash = actionHash(name, input);
    if (takeApproval(guard.taskId, hash)) return "run"; // approved this exact action, once
    if (isDenied(guard.taskId, hash)) return "denied";
    const message = describe(name, input, risk);
    this.pendingApproval = { message, risk, token: hash };
    this.add({ type: "notice", level: "warn", text: `Paused for your approval — ${message}` } as AgentEvent);
    return "ask";
  }

  private async runTools(calls: Extract<Block, { type: "tool_call" }>[], toolMap: Map<string, Tool>, signal: AbortSignal, planEv: { current: AgentEvent | null }): Promise<Block[]> {
    const runOne = async (c: (typeof calls)[number]): Promise<Block> => {
      const ev = this.turnToolEvents.get(c.id) ?? this.add({ type: "tool", name: c.name, input: c.input, status: "running" } as AgentEvent);
      this.patch(ev, { status: "running", output: "" } as Partial<AgentEvent>);
      const tool = toolMap.get(c.name);
      const input = (c.input ?? {}) as Record<string, unknown>;
      const verdict = tool && !("__invalid_json" in input) ? this.gate(c.name, input) : "run";
      let res;
      if (!tool) res = { content: `Unknown tool "${c.name}".`, isError: true };
      else if ("__invalid_json" in input) res = { content: `Your tool input was not valid JSON: ${String(input.__invalid_json).slice(0, 500)}`, isError: true };
      else if (verdict === "ask") {
        // Destructive/outward action with no prior grant: stop here and ask. The card stays open so the
        // user sees exactly what was proposed; the adapter turns this into a "blocked - needs approval".
        const pending = this.pendingApproval;
        res = {
          content: `[awaiting the user's approval] ${pending?.message ?? "This action needs a decision before it can run."} The action has NOT run yet. Continue with anything else you can do without it, or stop and wait.`,
          isError: false,
        };
      } else if (verdict === "denied") {
        res = { content: "The user denied this action. Do not retry it or look for a way around it; continue with another approach or finish and explain what is blocked.", isError: true };
      } else {
        try {
          res = await tool.run(input, {
            sessionId: this.meta.id,
            cwd: this.meta.cwd,
            setCwd: (d) => {
              this.meta.cwd = d;
              saveMeta(this.meta);
            },
            signal,
            onOutput: (chunk) => this.patch(ev, {}, { field: "output", value: chunk }),
            setPlan: (items: PlanItem[]) => {
              this.meta.plan = items;
              saveMeta(this.meta);
              if (planEv.current) this.patch(planEv.current, { items } as Partial<AgentEvent>);
              else planEv.current = this.add({ type: "plan", items } as AgentEvent);
            },
          });
        } catch (e) {
          res = { content: signal.aborted ? "[interrupted by user]" : `Error: ${(e as Error).message}`, isError: true };
        }
      }
      this.patch(ev, { status: res.isError ? "error" : "ok", output: res.content, images: res.images, endTs: Date.now() } as Partial<AgentEvent>);
      return { type: "tool_result", id: c.id, content: res.content, isError: res.isError, images: res.images };
    };
    if (calls.every((c) => READ_ONLY.has(c.name))) return Promise.all(calls.map(runOne));
    const out: Block[] = [];
    for (const c of calls) {
      if (signal.aborted) out.push({ type: "tool_result", id: c.id, content: "[skipped: stopped by user]", isError: true });
      else out.push(await runOne(c));
    }
    return out;
  }

  // ---- Context compaction (visible) ----

  private stripThinking() {
    for (const m of this.history) if (m.role === "assistant") m.blocks = m.blocks.filter((b) => b.type !== "thinking");
    this.history = this.history.filter((m) => m.blocks.length);
  }

  private async maybeCompact(signal: AbortSignal, force: boolean, reason?: string) {
    const window = contextWindow(activeProviders()[0]);
    const size = () => estimateTokens(this.history) + this.overhead;
    const used = Math.max(this.context.tokens, size());
    if (!force && used < window * 0.75) return;

    const before = used;
    // Stage 1: shed bulk from old tool outputs and screenshots; usually enough and costs nothing.
    const keepRecent = 8;
    let shed = 0;
    this.history.forEach((m, i) => {
      if (i >= this.history.length - keepRecent) return;
      for (const b of m.blocks) {
        if (b.type === "tool_result") {
          if (b.images?.length) (shed += b.images.length), (b.images = undefined);
          if (b.content.length > 1500) {
            shed++;
            b.content = b.content.slice(0, 700) + "\n…[trimmed during compaction]…\n" + b.content.slice(-500);
          }
        }
        if (b.type === "image") Object.assign(b, { type: "text", text: "[image removed during compaction]" }), shed++;
      }
    });
    // Signed thinking is bound to the exact prior context; once we rewrite history it must go.
    this.stripThinking();
    const afterTrim = size();
    if (!force && shed > 0 && afterTrim < window * 0.5) {
      this.add({ type: "compaction", before, after: afterTrim, summary: `Trimmed ${shed} old tool outputs and images. Recent work kept verbatim.`, reason: "Context 75% full", done: true } as AgentEvent);
      this.setContext(afterTrim);
      return;
    }

    // Stage 2: summarize everything before a clean cut point, streamed so the user can read it.
    let cut = -1;
    // Search from the very end: compaction often fires right after the user's newest message was appended, and
    // that message must survive verbatim rather than be folded into the summary.
    for (let i = this.history.length - 1; i > 0; i--) {
      const m = this.history[i];
      if (m.role === "user" && !m.blocks.some((b) => b.type === "tool_result")) {
        cut = i;
        break;
      }
    }
    const head = cut > 0 ? this.history.slice(0, cut) : this.history;
    const tail = cut > 0 ? this.history.slice(cut) : [];
    const ev = this.add({ type: "compaction", before, after: 0, summary: "", reason: reason ?? "Context nearly full", done: false } as AgentEvent);
    const transcript = head
      .map((m) =>
        m.blocks
          .map((b) =>
            b.type === "text" ? `${m.role.toUpperCase()}: ${b.text}` : b.type === "tool_call" ? `TOOL CALL ${b.name}: ${JSON.stringify(b.input).slice(0, 1500)}` : b.type === "tool_result" ? `RESULT${b.isError ? " (error)" : ""}: ${b.content.slice(0, 2500)}` : "",
          )
          .filter(Boolean)
          .join("\n"),
      )
      .join("\n\n");
    const r = await routeTurn(
      {
        system: "You compress agent work logs into a precise handoff so the same agent can continue seamlessly.",
        messages: [
          {
            role: "user",
            blocks: [
              {
                type: "text",
                text: `Summarize this session for continuation. Include: the user's goals and explicit instructions (verbatim where it matters), key facts discovered, files touched (full paths) and their state, commands that worked/failed, current plan and exactly what remains, and any open questions. Be dense and specific; omit pleasantries.\n\n<log>\n${fitLog(transcript, Math.floor(window * 0.55 * 4))}\n</log>`,
              },
            ],
          },
        ],
        tools: [],
        signal,
        maxTokens: 8000,
      },
      { onThinking: () => {}, onText: (d) => this.patch(ev, {}, { field: "summary", value: d }), onToolStart: () => {}, onToolInput: () => {}, onBlockEnd: () => {} },
      { onNotice: (l, t) => this.add({ type: "notice", level: l, text: t } as AgentEvent), onAttempt: () => this.patch(ev, { summary: "" } as Partial<AgentEvent>) },
    );
    const summary = r.blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
    this.history = [{ role: "user", blocks: [{ type: "text", text: `[Context was compacted. Summary of earlier work:]\n\n${summary}` }] }, ...(tail.length ? [{ role: "assistant" as const, blocks: [{ type: "text" as const, text: "Understood, continuing." }] }, ...tail] : [])];
    const after = size();
    this.patch(ev, { summary, after, done: true } as Partial<AgentEvent>);
    this.setContext(after, r.provider);
    this.flush();
  }
}

function attachmentBlocks(a: Attachment): Block[] {
  const note: Block = { type: "text", text: `[Attached file: ${a.name} (${fmtBytes(a.size)}, ${a.mime || "unknown type"}) saved at ${a.path}]` };
  if (/^image\/(png|jpe?g|gif|webp)$/.test(a.mime) && a.size < 5_000_000)
    return [note, { type: "image", image: { mediaType: a.mime.replace("jpg", "jpeg"), data: fs.readFileSync(a.path).toString("base64") } }];
  const textual = /^text\/|json|xml|javascript|typescript|yaml|csv|markdown|x-sh|sql/.test(a.mime) || /\.(md|txt|ts|tsx|js|jsx|py|go|rs|java|c|cpp|h|rb|sh|json|ya?ml|toml|csv|sql|html|css|log)$/i.test(a.name);
  if (textual && a.size < 60_000) return [note, { type: "text", text: `<file name="${a.name}">\n${fs.readFileSync(a.path, "utf8")}\n</file>` }];
  return [{ type: "text", text: `${(note as { text: string }).text}\nIt is too large or not plain text to inline; use read_file (paged) or search/bash to work with it.` }];
}

/** Fit a log into `max` chars, keeping the opening (the user's original instructions) and the most recent work. */
function fitLog(log: string, max: number) {
  if (log.length <= max) return log;
  const head = Math.min(20_000, Math.floor(max / 5));
  return `${log.slice(0, head)}\n…[middle of the log omitted to fit the model's context]…\n${log.slice(-(max - head))}`;
}

const fmtBytes = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.ceil(n / 1e3)} KB`);

const g = globalThis as unknown as { __swarmSessions?: Map<string, Session> };
const sessions = (g.__swarmSessions ??= new Map());

export function session(id: string): Session | null {
  let s = sessions.get(id);
  if (!s) {
    const meta = getMeta(id);
    if (!meta) return null;
    s = new Session(meta);
    sessions.set(id, s);
  }
  return s;
}

/** Called once at server boot: pick up every run that was still going when the process died. */
export function resumeActiveSessions() {
  for (const m of listSessions()) if (m.active || m.pendingInput?.length) session(m.id)?.resume();
}

// The task runtime (lib/runtime) drives the agent through this adapter: it queues a task, we run it as a normal
// message in the task's session and report turns, tools and quota waits back for its ledger and budgets.
setAgentAdapter({
  async run(task, hooks) {
    const s = session(task.sessionId);
    if (!s) throw new Error(`Session ${task.sessionId} not found`);
    // Text events are patched in place as they stream, so holding the latest one gives the final reply.
    let reply: AgentEvent | null = null;
    const sub = (op: StreamOp) => {
      if (op.op === "add" && op.event.type === "text") reply = op.event;
      else if (op.op === "add" && op.event.type === "turn") {
        const t = op.event;
        hooks.onTurn({ inputTokens: t.inputTokens, outputTokens: t.outputTokens, cachedTokens: t.cachedTokens, provider: t.provider, model: t.model });
      } else if (op.op === "add" && op.event.type === "notice") {
        const m = /Waiting (\d+)(s|m) for /.exec(op.event.text);
        if (m) hooks.onQuotaWait(+m[1] * (m[2] === "m" ? 60_000 : 1000), op.event.text);
        else hooks.onNote(op.event.text);
      } else if (op.op === "patch" && "status" in op.patch && (op.patch.status === "ok" || op.patch.status === "error")) {
        const ev = s.events.find((e) => e.id === op.id);
        if (ev?.type === "tool") hooks.onTool(ev.name, op.patch.status === "ok");
      }
    };
    const onAbort = () => s.stop();
    s.subs.add(sub);
    s.pendingApproval = null;
    setTaskGuard(s.meta.id, task.id);
    hooks.signal.addEventListener("abort", onAbort, { once: true });
    try {
      s.send(task.prompt, []);
      await s.whenIdle();
    } finally {
      s.subs.delete(sub);
      clearTaskGuard(s.meta.id);
      hooks.signal.removeEventListener("abort", onAbort);
    }
    const pending = (s as { pendingApproval: Session["pendingApproval"] }).pendingApproval;
    s.pendingApproval = null;
    const last = reply as AgentEvent | null;
    if (pending) return { summary: `Paused for approval: ${pending.message}`, verified: false, needs: { kind: "approval", message: pending.message, token: pending.token } };
    return { summary: last?.type === "text" ? last.text : "" };
  },
  stop: (sessionId) => sessions.get(sessionId)?.stop(),
  isRunning: (sessionId) => !!sessions.get(sessionId)?.running,
});

export function dropSession(id: string) {
  sessions.get(id)?.stop();
  sessions.delete(id);
}

export const uploadDir = (id: string) => {
  const d = path.join(UPLOADS_DIR, id);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
