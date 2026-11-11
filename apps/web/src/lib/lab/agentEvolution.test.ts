import { describe, it, expect } from 'vitest';
import {
  createTunedAgent,
  lockAgentDna,
  listTunedAgents,
  getTunedAgent,
  breedAgents,
  BENCHMARK_CHALLENGES,
} from './agentEvolution';

describe('Agent Evolution & Benchmark Engine', () => {
  it('creates a tuned agent with custom prompt context DNA', () => {
    const agent = createTunedAgent({
      name: 'Titan-Architect',
      role: 'architect',
      llmConfig: {
        provider: 'ollama',
        model: 'llama3.3:70b',
        temperature: 0.2,
        maxTokens: 4096,
        endpoint: 'http://localhost:11434',
      },
      contextDna: {
        systemDirective: 'Decompose with zero fluff and strict JSON DAG output.',
        personaTone: 'Rigorous and direct.',
        reasoningRules: ['Never output markdown outside code fence.'],
        outputConstraints: ['JSON array only.'],
        specializedKnowledge: ['Microservices', 'Kubernetes'],
        temperature: 0.2,
      },
      locked: false,
    });

    expect(agent.id).toContain('agent-gen0-');
    expect(agent.name).toBe('Titan-Architect');
    expect(agent.locked).toBe(false);
    expect(agent.contextDna.specializedKnowledge).toContain('Microservices');
  });

  it('locks agent DNA into an immutable profile', () => {
    const agent = createTunedAgent({
      name: 'Valkyrie-Verifier',
      role: 'verifier',
      llmConfig: {
        provider: 'deepseek',
        model: 'DeepSeek-V4-Flash-batch',
        temperature: 0.1,
        maxTokens: 2048,
      },
      contextDna: {
        systemDirective: 'Audit every acceptance criteria with strict gating.',
        personaTone: 'Uncompromising and precise.',
        reasoningRules: ['Reject any code with placeholder comments.'],
        outputConstraints: ['Pass / Fail bool with reason.'],
        specializedKnowledge: ['Security Auditing'],
        temperature: 0.1,
      },
      locked: false,
    });

    const locked = lockAgentDna(agent.id);
    expect(locked).not.toBeNull();
    expect(locked?.locked).toBe(true);
  });

  it('breeds two parent agents into a next-generation hybrid', () => {
    const parentA = createTunedAgent({
      name: 'A-Prime',
      role: 'architect',
      generation: 1,
      llmConfig: {
        provider: 'deepseek',
        model: 'DeepSeek-V4-Flash-batch',
        temperature: 0.2,
        maxTokens: 2048,
      },
      contextDna: {
        systemDirective: 'Architect directive A',
        personaTone: 'Analytical',
        reasoningRules: ['Rule A1'],
        outputConstraints: ['Constraint A1'],
        specializedKnowledge: ['Knowledge A1'],
        temperature: 0.2,
      },
    });

    const parentB = createTunedAgent({
      name: 'B-Prime',
      role: 'architect',
      generation: 1,
      llmConfig: {
        provider: 'deepseek',
        model: 'DeepSeek-V4-Flash-batch',
        temperature: 0.4,
        maxTokens: 2048,
      },
      contextDna: {
        systemDirective: 'Architect directive B',
        personaTone: 'Empirical',
        reasoningRules: ['Rule B1'],
        outputConstraints: ['Constraint B1'],
        specializedKnowledge: ['Knowledge B1'],
        temperature: 0.4,
      },
    });

    const child = breedAgents(parentA.id, parentB.id, 'Hybrid-Gen2');
    expect(child.generation).toBe(2);
    expect(child.name).toBe('Hybrid-Gen2');
    expect(child.parentIds).toContain(parentA.id);
    expect(child.parentIds).toContain(parentB.id);
    expect(child.contextDna.reasoningRules).toContain('Rule A1');
    expect(child.contextDna.reasoningRules).toContain('Rule B1');
  });

  it('provides standard objective benchmark challenges', () => {
    expect(BENCHMARK_CHALLENGES.length).toBeGreaterThanOrEqual(3);
    const authBench = BENCHMARK_CHALLENGES.find((b) => b.id === 'bench-decomp-auth');
    expect(authBench).toBeDefined();
    expect(authBench?.evaluationCriteria.length).toBeGreaterThan(0);
  });
});
