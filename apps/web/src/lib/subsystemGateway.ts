import { apiGet, type TestConsensusReport } from '@/lib/api_client';

export type { TestConsensusReport };

export type DesktopLlmStatus = {
  available: boolean;
  metrics?: Record<string, unknown>;
  note?: string;
};

export type ModalAppEntry = {
  id: string;
  name?: string;
  endpoint: string;
  model?: string;
  role?: string;
  configured?: boolean;
  status?: string;
  http_status?: number | null;
};

export type ModalRegistry = {
  available: boolean;
  count: number;
  apps: ModalAppEntry[];
  training_modules?: string[];
};

export type ModalHealth = {
  available: boolean;
  healthy: number;
  total: number;
  probes: ModalAppEntry[];
};

export function fetchDesktopLlmStatus(): Promise<DesktopLlmStatus> {
  return apiGet<DesktopLlmStatus>('/api/desktop-llm/status');
}

export function fetchDesktopLlmModels(): Promise<{
  available: boolean;
  models: string[];
  role_assignments: Record<string, string>;
}> {
  return apiGet('/api/desktop-llm/models');
}

export function fetchModalAppsRegistry(): Promise<ModalRegistry> {
  return apiGet<ModalRegistry>('/api/modal-apps/registry');
}

export function fetchModalAppsHealth(): Promise<ModalHealth> {
  return apiGet<ModalHealth>('/api/modal-apps/health');
}

export function fetchTestConsensus(demo = true): Promise<{
  ok: boolean;
  demo: boolean;
  report: TestConsensusReport;
}> {
  const qs = demo ? '?demo=1' : '';
  return apiGet(`/api/benchmark/test-consensus${qs}`);
}
