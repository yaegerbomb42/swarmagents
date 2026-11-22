#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import {
  type SwarmTask,
  type TaskProposal,
  type SwarmMessage,
  type TaskDifficulty,
  DIFFICULTY_RANK,
  normalizeDifficulty,
} from "./types.js";

const STORAGE_DIR = process.env.SWARM_HOME || path.join(os.homedir(), ".swarmagents");
const DATA_FILE = path.join(STORAGE_DIR, "swarm_board.json");

interface BoardStore {
  tasks: SwarmTask[];
  proposals: TaskProposal[];
  messages: SwarmMessage[];
}

function loadStore(): BoardStore {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
      return {
        tasks: data.tasks || [],
        proposals: data.proposals || [],
        messages: data.messages || [],
      };
    }
  } catch {}
  return { tasks: [], proposals: [], messages: [] };
}

function saveStore(store: BoardStore) {
  try {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
    const tmp = `${DATA_FILE}.tmp.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf-8");
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) {
    console.error("Failed to persist swarm board store:", err);
  }
}

const server = new Server(
  {
    name: "mcp-swarm-board",
    version: "2.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "create_task",
        description: "Orchestrator tool to post new prioritized tasks with an explicit difficulty (easy, medium, or hard).",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Title of the task" },
            description: { type: "string", description: "Detailed specification" },
            difficulty: {
              type: "string",
              enum: ["easy", "medium", "hard"],
              description: "Difficulty: easy, medium, or hard",
            },
            constraints: {
              type: "array",
              items: { type: "string" },
              description: "Rules, tests required, breaking change boundaries",
            },
          },
          required: ["title", "description", "difficulty"],
        },
      },
      {
        name: "poll_tasks",
        description: "Worker tool to query tasks. If no open tasks exist, workers should scout the repo and submit proposals.",
        inputSchema: {
          type: "object",
          properties: {
            difficulty: { type: "string", enum: ["easy", "medium", "hard"], description: "Only tasks of this difficulty" },
            status: { type: "string", enum: ["open", "claimed", "in_review", "completed", "blocked"] },
          },
        },
      },
      {
        name: "claim_task",
        description: "Claim an open task. Any agent may claim any open task.",
        inputSchema: {
          type: "object",
          properties: {
            taskId: { type: "string", description: "Task ID" },
            agentName: { type: "string", description: "Agent name" },
          },
          required: ["taskId", "agentName"],
        },
      },
      {
        name: "submit_task_work",
        description: "Submit branch and PR summary once work passes tests.",
        inputSchema: {
          type: "object",
          properties: {
            taskId: { type: "string", description: "Task ID" },
            gitBranch: { type: "string", description: "Git branch with committed changes" },
            prUrl: { type: "string", description: "Optional PR URL if pushed to remote" },
            summary: { type: "string", description: "Summary of changes, test passes, and diff" },
          },
          required: ["taskId", "gitBranch", "summary"],
        },
      },
      {
        name: "submit_proposal",
        description: "Worker tool to propose improvements, bug fixes, or optimizations when the backlog has no work.",
        inputSchema: {
          type: "object",
          properties: {
            proposedBy: { type: "string", description: "Agent name proposing the task" },
            title: { type: "string", description: "Proposed task title" },
            problem: { type: "string", description: "What bug or architectural issue was discovered" },
            proposedSolution: { type: "string", description: "How you propose solving it" },
            suggestedDifficulty: {
              type: "string",
              enum: ["easy", "medium", "hard"],
              description: "Suggested difficulty level",
            },
          },
          required: ["proposedBy", "title", "problem", "proposedSolution", "suggestedDifficulty"],
        },
      },
      {
        name: "poll_proposals",
        description: "Orchestrator tool to view pending bug/improvement proposals from scouting workers.",
        inputSchema: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["pending", "approved", "rejected"] },
          },
        },
      },
      {
        name: "judge_proposal",
        description: "Orchestrator tool to approve or reject a proposal. Approving automatically converts it into an open task.",
        inputSchema: {
          type: "object",
          properties: {
            proposalId: { type: "string", description: "Proposal ID to judge" },
            approved: { type: "boolean", description: "Approve or reject" },
            feedback: { type: "string", description: "Orchestrator decision notes" },
            finalDifficulty: {
              type: "string",
              enum: ["easy", "medium", "hard"],
              description: "Override difficulty if different from proposal",
            },
          },
          required: ["proposalId", "approved"],
        },
      },
      {
        name: "review_and_merge_task",
        description: "Orchestrator tool to verify submitted work on a branch and merge it into main.",
        inputSchema: {
          type: "object",
          properties: {
            taskId: { type: "string", description: "Task ID" },
            approved: { type: "boolean", description: "Approve or reject" },
            feedback: { type: "string", description: "Feedback or merge notes" },
            autoMergeGit: {
              type: "boolean",
              description: "If true, merges the git branch into current branch via git merge --no-ff",
            },
            repoPath: { type: "string", description: "Repository root path (optional for git merge)" },
          },
          required: ["taskId", "approved", "feedback"],
        },
      },
      {
        name: "post_swarm_message",
        description: "Post messages or dispatch idle scouting orders.",
        inputSchema: {
          type: "object",
          properties: {
            fromAgent: { type: "string", description: "Sender agent" },
            channel: { type: "string", enum: ["general", "blockers", "announcements", "idle_scouts"] },
            content: { type: "string", description: "Message" },
          },
          required: ["fromAgent", "channel", "content"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const store = loadStore();
  const name = request.params.name;
  const args = request.params.arguments as any;

  if (name === "create_task") {
    const difficulty: TaskDifficulty = normalizeDifficulty(args.difficulty) || "medium";
    const task: SwarmTask = {
      id: `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      title: args.title,
      description: args.description,
      difficulty,
      constraints: args.constraints || [],
      status: "open",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    store.tasks.push(task);
    saveStore(store);
    return {
      content: [{ type: "text", text: JSON.stringify({ message: "Task created", task }, null, 2) }],
    };
  }

  if (name === "poll_tasks") {
    const status = args.status || "open";
    const difficultyFilter = normalizeDifficulty(args.difficulty);
    const hasDifficultyFilter = typeof args.difficulty === "string";

    const filtered = store.tasks
      .filter((t) => t.status === status)
      .filter((t) => !hasDifficultyFilter || normalizeDifficulty(t.difficulty) === difficultyFilter)
      .sort(
        (a, b) =>
          DIFFICULTY_RANK[normalizeDifficulty(a.difficulty)] - DIFFICULTY_RANK[normalizeDifficulty(b.difficulty)] ||
          b.updatedAt - a.updatedAt ||
          a.id.localeCompare(b.id),
      );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              count: filtered.length,
              tasks: filtered,
              instructions:
                filtered.length === 0
                  ? "Backlog is clear. Initiate idle scouting: scan codebase for bugs, performance leaks, or missing tests, then call submit_proposal."
                  : undefined,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  if (name === "claim_task") {
    const task = store.tasks.find((t) => t.id === args.taskId);
    if (!task) throw new Error(`Task ${args.taskId} not found`);
    if (task.status !== "open") throw new Error(`Task ${args.taskId} is already ${task.status}`);

    task.status = "claimed";
    task.claimedBy = args.agentName;
    task.updatedAt = Date.now();
    saveStore(store);

    return {
      content: [{ type: "text", text: JSON.stringify({ message: `Claimed by ${args.agentName}`, task }, null, 2) }],
    };
  }

  if (name === "submit_task_work") {
    const task = store.tasks.find((t) => t.id === args.taskId);
    if (!task) throw new Error(`Task ${args.taskId} not found`);

    task.status = "in_review";
    task.gitBranch = args.gitBranch;
    task.prUrl = args.prUrl;
    task.resultSummary = args.summary;
    task.updatedAt = Date.now();
    saveStore(store);

    return {
      content: [{ type: "text", text: JSON.stringify({ message: `Submitted for review`, task }, null, 2) }],
    };
  }

  if (name === "submit_proposal") {
    const proposal: TaskProposal = {
      id: `prop_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      proposedBy: args.proposedBy,
      title: args.title,
      problem: args.problem,
      proposedSolution: args.proposedSolution,
      suggestedDifficulty: args.suggestedDifficulty,
      status: "pending",
      createdAt: Date.now(),
    };
    store.proposals.push(proposal);
    saveStore(store);

    return {
      content: [{ type: "text", text: JSON.stringify({ message: "Proposal submitted to Orchestrator", proposal }, null, 2) }],
    };
  }

  if (name === "poll_proposals") {
    const status = args.status || "pending";
    const filtered = store.proposals.filter((p) => p.status === status);
    return {
      content: [{ type: "text", text: JSON.stringify({ count: filtered.length, proposals: filtered }, null, 2) }],
    };
  }

  if (name === "judge_proposal") {
    const proposal = store.proposals.find((p) => p.id === args.proposalId);
    if (!proposal) throw new Error(`Proposal ${args.proposalId} not found`);

    proposal.status = args.approved ? "approved" : "rejected";
    proposal.orchestratorFeedback = args.feedback;

    let createdTask: SwarmTask | undefined;
    if (args.approved) {
      const difficulty: TaskDifficulty = normalizeDifficulty(args.finalDifficulty || proposal.suggestedDifficulty);
      createdTask = {
        id: `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        title: proposal.title,
        description: `[From Scout Proposal by ${proposal.proposedBy}]\n\nProblem:\n${proposal.problem}\n\nSolution Spec:\n${proposal.proposedSolution}`,
        difficulty,
        constraints: ["Must be implemented on git branch", "Unit tests required"],
        status: "open",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      proposal.promotedTaskId = createdTask.id;
      store.tasks.push(createdTask);
    }
    saveStore(store);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              message: args.approved ? "Proposal approved and converted into open task" : "Proposal rejected",
              proposal,
              createdTask,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  if (name === "review_and_merge_task") {
    const task = store.tasks.find((t) => t.id === args.taskId);
    if (!task) throw new Error(`Task ${args.taskId} not found`);

    let mergeLog = "";
    if (args.approved) {
      if (args.autoMergeGit && task.gitBranch) {
        try {
          const cwd = args.repoPath || process.cwd();
          execSync(`git fetch . ${task.gitBranch}:${task.gitBranch} && git merge ${task.gitBranch} -m "merge: ${task.title} (${task.id})"`, {
            cwd,
            stdio: "pipe",
          });
          mergeLog = `Successfully merged branch ${task.gitBranch} into current branch.`;
        } catch (e: any) {
          mergeLog = `Git merge error: ${e.message}`;
        }
      }
      task.status = "completed";
    } else {
      task.status = "open"; // Bounced back for rework
    }

    task.updatedAt = Date.now();
    saveStore(store);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              message: args.approved ? "Task approved and closed" : "Task rejected and returned to backlog",
              task,
              mergeLog,
              feedback: args.feedback,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  if (name === "post_swarm_message") {
    const msg: SwarmMessage = {
      id: `msg_${Date.now()}`,
      fromAgent: args.fromAgent,
      channel: args.channel,
      content: args.content,
      timestamp: Date.now(),
    };
    store.messages.push(msg);
    saveStore(store);
    return {
      content: [{ type: "text", text: JSON.stringify({ message: "Message posted", msg }, null, 2) }],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Swarm Task Blackboard MCP server v2.0 running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
