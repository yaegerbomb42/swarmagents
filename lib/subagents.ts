import os from "node:os";
import type { Block, Msg } from "./types";
import { contextWindow, estimateTokens, routeTurn, activeProviders } from "./router";
import { ProviderError } from "./providers/types";
import type { Tool, ToolContext, ToolResult } from "./tools/types";

// Sub-agents: the main agent hands independent pieces of work to child agents that run in parallel, each with its
// own context window, and gets back one concise report per child. Children are headless (no plan, no steering),
// can't spawn further children, and their progress streams into the parent's tool card so nothing is hidden.

const MAX_CHILDREN = 4;
const MAX_CHILD_STEPS = 150;
const READ_ONLY = new Set(["read_file", "search", "web_search", "web_fetch"]);
/** One shared Chrome: concurrent children driving it would trample each other. */
const EXCLUSIVE = new Set(["browser"]);

interface Job {
  title: string;
  prompt: string;
}

const childSystem = (cwd: string, title: string) => `You are a sub-agent working for a lead agent on one focused piece of a larger task: "${title}". You run on the user's Mac with real tools; other sub-agents work in parallel on other pieces, so stay strictly inside your assignment and don't touch files or resources outside it.
- Work autonomously to completion. There is no user to ask; if something is ambiguous, make the most reasonable choice and note it.
- Verify what you do (run it, re-read it) before reporting.
- Finish with a dense report for the lead agent: what you did, what you found (with exact paths, commands, URLs, numbers), what is verified vs. assumed, and anything left undone. No pleasantries.
Environment: macOS, home ${os.homedir()}, current directory ${cwd}. Date ${new Date().toDateString()}.`;

const brief = (input: unknown) => {
  const s = JSON.stringify(input) ?? "";
  return s.length > 140 ? s.slice(0, 140) + "…" : s;
};

/** Keep a child's history inside its window by shedding old tool output; children never summarize. */
function trim(history: Msg[], window: number) {
  if (estimateTokens(history) < window * 0.6) return;
  history.forEach((m, i) => {
    if (i >= history.length - 6) return;
    for (const b of m.blocks) {
      if (b.type === "tool_result") {
        b.images = undefined;
        if (b.content.length > 800) b.content = b.content.slice(0, 400) + "\n…[trimmed]…\n" + b.content.slice(-300);
      }
    }
    if (m.role === "assistant") m.blocks = m.blocks.filter((b) => b.type !== "thinking");
  });
}

async function runChild(job: Job, tools: Tool[], ctx: ToolContext, log: (s: string) => void): Promise<string> {
  const toolMap = new Map(tools.map((t) => [t.spec.name, t]));
  const history: Msg[] = [{ role: "user", blocks: [{ type: "text", text: job.prompt }] }];
  let cwd = ctx.cwd;
  let lastText = "";
  const quiet = { onThinking() {}, onText() {}, onToolStart() {}, onToolInput() {}, onBlockEnd() {} };

  for (let step = 0; step < MAX_CHILD_STEPS; step++) {
    trim(history, contextWindow(activeProviders()[0]));
    const r = await routeTurn(
      { system: childSystem(cwd, job.title), messages: history, tools: tools.map((t) => t.spec), signal: ctx.signal },
      quiet,
      { onNotice: (_l, t) => log(`· ${t}`), onAttempt() {} },
    );
    history.push({ role: "assistant", blocks: r.blocks });
    const text = r.blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n").trim();
    if (text) lastText = text;
    const calls = r.blocks.filter((b): b is Extract<Block, { type: "tool_call" }> => b.type === "tool_call");
    if (!calls.length) {
      if (r.stop === "max_tokens") {
        history.push({ role: "user", blocks: [{ type: "text", text: "Continue exactly where you left off." }] });
        continue;
      }
      return lastText || "(the sub-agent finished without a report)";
    }

    const runOne = async (c: (typeof calls)[number]): Promise<Block> => {
      log(`→ ${c.name} ${brief(c.input)}`);
      const tool = toolMap.get(c.name);
      const input = (c.input ?? {}) as Record<string, unknown>;
      let res: ToolResult;
      if (!tool) res = { content: `Unknown tool "${c.name}".`, isError: true };
      else if ("__invalid_json" in input) res = { content: `Your tool input was not valid JSON.`, isError: true };
      else {
        try {
          res = await tool.run(input, { ...ctx, cwd, setCwd: (d) => (cwd = d), onOutput() {}, setPlan() {} });
        } catch (e) {
          res = { content: ctx.signal.aborted ? "[interrupted]" : `Error: ${(e as Error).message}`, isError: true };
        }
      }
      if (res.isError) log(`  ✗ ${res.content.slice(0, 160).replace(/\s+/g, " ")}`);
      return { type: "tool_result", id: c.id, content: res.content, isError: res.isError, images: res.images };
    };
    const results = calls.every((c) => READ_ONLY.has(c.name)) ? await Promise.all(calls.map(runOne)) : await calls.reduce<Promise<Block[]>>(async (acc, c) => [...(await acc), await runOne(c)], Promise.resolve([]));
    history.push({ role: "user", blocks: results });
  }
  return `[stopped after ${MAX_CHILD_STEPS} steps]\n${lastText}`;
}

/** The fan-out tool. `tools` is the parent's toolset; children get it minus this tool (no recursion). */
export function subagentTool(tools: Tool[]): Tool {
  return {
    spec: {
      name: "subagent",
      description: `Run 1-${MAX_CHILDREN} independent sub-tasks in parallel, each by a separate sub-agent with its own fresh context and your full toolset. Use it when work splits into pieces that don't depend on each other (research several topics, investigate separate parts of a codebase, build separate files/modules) or to keep a bulky investigation out of your own context. Each prompt must be self-contained: the sub-agent sees nothing of this conversation, so include paths, goals, constraints and what to report. Give parallel sub-agents separate files/areas. Only the first sub-agent may use the browser. Returns each sub-agent's final report.`,
      schema: {
        type: "object",
        properties: {
          tasks: {
            type: "array",
            minItems: 1,
            maxItems: MAX_CHILDREN,
            items: {
              type: "object",
              properties: { title: { type: "string", description: "Short label shown to the user" }, prompt: { type: "string", description: "Complete, self-contained instructions" } },
              required: ["title", "prompt"],
            },
          },
        },
        required: ["tasks"],
      },
    },
    async run(input, ctx) {
      const jobs = ((input.tasks as Job[]) ?? []).filter((j) => j?.prompt).slice(0, MAX_CHILDREN);
      if (!jobs.length) return { content: "No tasks given.", isError: true };
      const base = tools.filter((t) => t.spec.name !== "subagent");
      const started = Date.now();
      const reports = await Promise.all(
        jobs.map(async (job, i) => {
          const tag = `[${i + 1}·${job.title.slice(0, 40)}]`;
          const log = (s: string) => ctx.onOutput(`${tag} ${s}\n`);
          log("started");
          try {
            const own = i === 0 ? base : base.filter((t) => !EXCLUSIVE.has(t.spec.name));
            const report = await runChild(job, own, ctx, log);
            log("done");
            return { job, ok: true, report };
          } catch (e) {
            const msg = e instanceof ProviderError && e.kind === "aborted" ? "stopped" : (e as Error).message;
            log(`failed: ${msg}`);
            return { job, ok: false, report: `Failed: ${msg}` };
          }
        }),
      );
      const secs = Math.round((Date.now() - started) / 1000);
      const content = reports.map((r, i) => `## Sub-agent ${i + 1}: ${r.job.title}${r.ok ? "" : " (failed)"}\n${r.report}`).join("\n\n");
      return { content: `${reports.filter((r) => r.ok).length}/${reports.length} sub-agents finished in ${secs}s.\n\n${content}`, isError: reports.every((r) => !r.ok) };
    },
  };
}
