import { performance } from "node:perf_hooks";
import {
  DECISION_JSON_SCHEMA,
  parseDecisionPayload,
  truncateReasonToTwelveWords,
  type DecisionPayload,
} from "./schema";
import type {
  AgentSnapshot,
  DecisionResult,
  DecisionRouter,
  ModelEndpointConfig,
} from "./types";
import type { DecisionLogger } from "./logger";

const SYSTEM_PROMPT = [
  "You are a strict coding-agent loop controller.",
  "Given an agent snapshot, choose exactly one next decision:",
  "- continue: progress is healthy and more work remains.",
  "- retry: last step failed with a recoverable error and budget remains.",
  "- ask: action is destructive, ambiguous, or requires human approval/secrets.",
  "- verify: implementation appears complete and should be tested/verified.",
  "- stop: verification passed, budget is exhausted, or task is unrecoverably blocked.",
  "Respond ONLY with JSON matching the schema. Reason must be <= 12 words.",
].join("\n");

const DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  /\brm\s+-[a-z]*r[a-z]*f\b/i,
  /\brm\s+-[a-z]*f[a-z]*r\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+push\s+(?:--force|-f)\b/i,
  /\bdrop\s+(?:table|database|schema)\b/i,
  /\btruncate\s+table\b/i,
  /\bmkfs\./i,
  /\bdd\s+if=/i,
  /\bchmod\s+-R\s+777\b/i,
  />\s*\/dev\/sd[a-z]/i,
  /\bdelete\s+from\s+\w+\s*;/i,
];

export function detectHighStakesReason(
  snapshot: AgentSnapshot,
  candidateDecision?: DecisionPayload["decision"],
): string | null {
  if (candidateDecision === "ask") {
    return "high-stakes:ask-human";
  }

  const serializedCall = snapshot.lastToolCall
    ? `${snapshot.lastToolCall.name} ${JSON.stringify(snapshot.lastToolCall.args)}`
    : "";
  const combined = `${snapshot.goal}\n${serializedCall}\n${snapshot.error ?? ""}`;

  for (const pattern of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(combined)) {
      return `high-stakes:destructive-pattern(${pattern.source})`;
    }
  }
  return null;
}

export interface LocalEscalatingRouterOptions {
  local: ModelEndpointConfig;
  big: ModelEndpointConfig;
  confidenceThreshold?: number;
  logger?: DecisionLogger;
  fetchImpl?: typeof fetch;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
}

export class LocalEscalatingRouter implements DecisionRouter {
  private readonly local: ModelEndpointConfig;
  private readonly big: ModelEndpointConfig;
  private readonly confidenceThreshold: number;
  private readonly logger?: DecisionLogger;
  private readonly fetchImpl: typeof fetch;

  constructor(options: LocalEscalatingRouterOptions) {
    this.local = options.local;
    this.big = options.big;
    this.confidenceThreshold = options.confidenceThreshold ?? 0.75;
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async decide(snapshot: AgentSnapshot): Promise<DecisionResult> {
    const start = performance.now();
    let localPayload: DecisionPayload | null = null;
    let escalationReason: string | null = null;

    try {
      localPayload = await this.callModel(this.local, snapshot);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      escalationReason = `local-error:${msg.slice(0, 80)}`;
    }

    if (localPayload) {
      const highStakes = detectHighStakesReason(snapshot, localPayload.decision);
      if (highStakes) {
        escalationReason = highStakes;
      } else if (localPayload.confidence < this.confidenceThreshold) {
        escalationReason = `low-confidence:${localPayload.confidence.toFixed(2)}<${this.confidenceThreshold.toFixed(2)}`;
      }
    }

    let finalResult: DecisionResult;

    if (escalationReason) {
      const bigPayload = await this.callModel(this.big, snapshot, escalationReason);
      finalResult = {
        decision: bigPayload.decision,
        confidence: bigPayload.confidence,
        reason: truncateReasonToTwelveWords(bigPayload.reason),
        escalated: true,
      };
    } else {
      finalResult = {
        decision: localPayload!.decision,
        confidence: localPayload!.confidence,
        reason: truncateReasonToTwelveWords(localPayload!.reason),
        escalated: false,
      };
    }

    const latencyMs = Number((performance.now() - start).toFixed(2));
    if (this.logger) {
      await this.logger.log({
        timestamp: new Date().toISOString(),
        turnCount: snapshot.turnCount,
        decision: finalResult.decision,
        confidence: finalResult.confidence,
        reason: finalResult.reason,
        escalated: finalResult.escalated,
        escalationReason,
        localModel: this.local.model,
        bigModel: this.big.model,
        latencyMs,
      });
    }

    return finalResult;
  }

  private async callModel(
    endpoint: ModelEndpointConfig,
    snapshot: AgentSnapshot,
    escalationNote?: string,
  ): Promise<DecisionPayload> {
    const url = `${endpoint.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), endpoint.timeoutMs ?? 20_000);

    const userContent = JSON.stringify({
      snapshot,
      ...(escalationNote ? { escalationNote } : {}),
    });

    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (endpoint.apiKey) {
      headers.authorization = `Bearer ${endpoint.apiKey}`;
    }

    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: endpoint.model,
          temperature: 0,
          max_tokens: 120,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "agent_decision",
              strict: true,
              schema: DECISION_JSON_SCHEMA,
            },
          },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userContent },
          ],
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 160)}`);
      }

      const data = (await res.json()) as ChatCompletionResponse;
      const content = data.choices?.[0]?.message?.content;
      if (!content || typeof content !== "string") {
        throw new Error("Model returned empty content");
      }

      return parseDecisionPayload(content);
    } finally {
      clearTimeout(timeout);
    }
  }
}
