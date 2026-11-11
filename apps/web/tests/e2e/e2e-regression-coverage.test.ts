import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// Module under test imports
import * as HamiltonianRoute from '@/app/api/hamiltonian/route';
import * as HamiltonianDecideRoute from '@/app/api/hamiltonian/decide/route';
import * as QuantumPlanRoute from '@/app/api/quantum/hamiltonian/plan/route';
import * as HealthRoute from '@/app/api/health/route';
import {
  saveByokKey,
  getStoredByokKeys,
  getDecryptedKey,
  removeByokKey,
  clearMemoryVault,
} from '@/lib/lab/byokVault';
import { planToHamiltonianGraph } from '@/components/quantum/HamiltonianViz';
import { BUNDLED_LANDING_LIFT } from '@/lib/landingLiftDemo';

describe('End-to-End Regression Suite: Core System Invariants', () => {
  // ────────────────────────────────────────────────────────────────────────────
  // Regression Suite 1: 1-Click Demo Execution Flow
  // ────────────────────────────────────────────────────────────────────────────
  describe('1. 1-Click Demo Execution Flow', () => {
    it('provides valid pre-baked bundled demo data for zero-latency instant preview', () => {
      expect(BUNDLED_LANDING_LIFT).toBeDefined();
      expect(BUNDLED_LANDING_LIFT.model).toBeTruthy();
      expect(BUNDLED_LANDING_LIFT.chat.output).toBeTruthy();
      expect(BUNDLED_LANDING_LIFT.swarm.output).toBeTruthy();
      expect(BUNDLED_LANDING_LIFT.chat.passed).toBe(false);
      expect(BUNDLED_LANDING_LIFT.swarm.passed).toBe(true);
      expect(BUNDLED_LANDING_LIFT.liftPercentagePoints).toBeGreaterThan(0);
    });

    it('simulates 1-click demo workflow execution via Trajectory steps generator', async () => {
      const demoRequestPayload = {
        start: 'plan',
        goal: 'submit',
        transitions: {
          plan: ['edit', 'test'],
          edit: ['test', 'submit'],
          test: ['submit', 'plan'],
          submit: ['plan'],
        },
        action_costs: { plan: 1, edit: 2, test: 1.5, submit: 0.5 },
      };

      const req = new NextRequest('http://localhost:3000/api/quantum/hamiltonian/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(demoRequestPayload),
      });

      const res = await QuantumPlanRoute.POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.plan).toBeDefined();
      expect(Array.isArray(data.plan.actions)).toBe(true);
      expect(data.plan.actions[0]).toBe('plan');
      expect(data.plan.actions[data.plan.actions.length - 1]).toBe('submit');
      expect(data.plan.total_energy).toBeGreaterThan(0);
    });

    it('handles malformed 1-click demo execution payloads with strict 400 validation', async () => {
      const req = new NextRequest('http://localhost:3000/api/quantum/hamiltonian/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ start: 'plan' }), // missing goal & transitions
      });

      const res = await QuantumPlanRoute.POST(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.ok).toBe(false);
      expect(data.error).toContain('start, goal, and transitions are required');
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Regression Suite 2: BYOK Connection & Storage Lifecycle
  // ────────────────────────────────────────────────────────────────────────────
  describe('2. BYOK Connection & Vault Lifecycle', () => {
    beforeEach(() => {
      clearMemoryVault();
    });

    afterEach(() => {
      clearMemoryVault();
    });

    it('securely stores, encrypts, and validates BYOK provider keys', () => {
      const testApiKey = 'sk-proj-super-secret-key-for-openai-byok-test-99999';
      const stored = saveByokKey('openai', 'OpenAI Custom', testApiKey, 'https://api.openai.com/v1');

      expect(stored.providerId).toBe('openai');
      expect(stored.name).toBe('OpenAI Custom');
      expect(stored.status).toBe('valid');
      expect(stored.isActive).toBe(true);
      expect(stored.baseUrl).toBe('https://api.openai.com/v1');
      // Verify raw key is never stored in plain text preview or raw field
      expect(stored.keyPreview).not.toBe(testApiKey);
      expect(stored.keyPreview).toContain('sk-p');
      expect(stored.keyPreview).toContain('9999');
      expect(stored.encryptedKey).not.toBe(testApiKey);

      // Verify decryption fidelity
      const decrypted = getDecryptedKey('openai');
      expect(decrypted).toBe(testApiKey);
    });

    it('prevents cross-provider leakage and supports multi-provider registration', () => {
      saveByokKey('anthropic', 'Anthropic Claude', 'sk-ant-anthropic-secret-key-1111');
      saveByokKey('deepseek', 'DeepSeek Official', 'sk-deepseek-secret-key-2222');
      saveByokKey('groq', 'Groq Fast Tier', 'gsk_groq_secret_key_3333');

      const allKeys = getStoredByokKeys();
      expect(allKeys.length).toBe(3);

      expect(getDecryptedKey('anthropic')).toBe('sk-ant-anthropic-secret-key-1111');
      expect(getDecryptedKey('deepseek')).toBe('sk-deepseek-secret-key-2222');
      expect(getDecryptedKey('groq')).toBe('gsk_groq_secret_key_3333');
      expect(getDecryptedKey('google')).toBeNull();
    });

    it('atomically removes revoked BYOK connections without affecting other keys', () => {
      saveByokKey('anthropic', 'Anthropic Claude', 'sk-ant-1234');
      saveByokKey('openai', 'OpenAI', 'sk-openai-5678');

      removeByokKey('anthropic');
      expect(getStoredByokKeys().length).toBe(1);
      expect(getDecryptedKey('anthropic')).toBeNull();
      expect(getDecryptedKey('openai')).toBe('sk-openai-5678');
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Regression Suite 3: Hamiltonian Phase-Space UI & Decider Endpoints
  // ────────────────────────────────────────────────────────────────────────────
  describe('3. Hamiltonian Phase-Space UI & Decider Endpoints', () => {
    it('computes spatial phase-space graph coordinates from planned action sequences', () => {
      const planActions = ['think', 'file_read', 'code_generate', 'task_complete'];
      const graph = planToHamiltonianGraph(planActions, 2);

      expect(graph.nodes.length).toBe(4);
      expect(graph.edges.length).toBe(3);

      // Verify node energy properties and normalized spatial coordinate bounds [0..1]
      graph.nodes.forEach((node) => {
        expect(node.x).toBeGreaterThanOrEqual(0);
        expect(node.x).toBeLessThanOrEqual(1);
        expect(node.y).toBeGreaterThanOrEqual(0);
        expect(node.y).toBeLessThanOrEqual(1);
        expect(typeof node.energy).toBe('number');
      });

      // Node at activeIndex (2: 'code_generate') has heightened active energy state (+1.0)
      const activeNode = graph.nodes.find((n) => n.id === 'code_generate');
      expect(activeNode).toBeDefined();
      expect(activeNode!.energy).toBe(2 * 0.5 + 1); // index 2 -> 1.0 + 1 = 2.0
    });

    it('serves GET /api/hamiltonian status and tool metadata', async () => {
      const res = await HamiltonianRoute.GET();
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.status).toBe('active');
      expect(data.fallback).toBe('local_qrc');
      expect(data.tools).toContain('hamiltonian_decide');
      expect(data.tools).toContain('hamiltonian_rank_actions');
      expect(data.tools).toContain('hamiltonian_feedback');
    });

    it('executes POST /api/hamiltonian decide request with resilient QRC fallback', async () => {
      const payload = {
        tool: 'decide',
        task_id: 'task-e2e-reg-001',
        task_label: 'Implement distributed consensus',
        step_index: 1,
        max_steps: 10,
        acceptance_met_ratio: 0.1,
      };

      const req = new NextRequest('http://localhost:3000/api/hamiltonian', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const res = await HamiltonianRoute.POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.optimal_action).toBeDefined();
      expect(data.phase).toBe('exploration');
      expect(typeof data.confidence).toBe('number');
      expect(typeof data.energy_delta).toBe('number');
      expect(Array.isArray(data.candidate_actions)).toBe(true);
    });

    it('executes POST /api/hamiltonian/decide direct endpoint with parameter validation', async () => {
      const validPayload = {
        task_id: 'task-phase-002',
        task_label: 'Finalize and commit code changes',
        step_index: 9,
        max_steps: 10,
        acceptance_met_ratio: 0.95,
      };

      const req = new NextRequest('http://localhost:3000/api/hamiltonian/decide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPayload),
      });

      const res = await HamiltonianDecideRoute.POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.optimal_action).toBeDefined();
      expect(data.phase).toBe('finalization');
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Regression Suite 4: Deployment Health & Readiness Invariants
  // ────────────────────────────────────────────────────────────────────────────
  describe('4. Deployment Health & Readiness Invariants', () => {
    it('verifies dashboard internal health endpoint contracts', async () => {
      const res = await HealthRoute.GET();
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.status).toBe('healthy');
      expect(data.service).toBe('swarmagents-dashboard');
      expect(typeof data.timestamp).toBe('string');
    });
  });
});
