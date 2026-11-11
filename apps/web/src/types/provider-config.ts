/**
 * TypeScript types for Provider Configuration System
 * 
 * These types match the backend provider configuration structure
 * for the task decomposition system.
 */

/**
 * Provider type enumeration
 */
export type ProviderType =
  | 'azure'
  | 'openai'
  | 'groq'
  | 'cerebras'
  | 'nvidia'
  | 'gemini'
  | 'anthropic'
  | 'ollama'
  | 'lambo'
  | 'custom'
  | 'gguf'
  | 'provider_manager';

/**
 * Single provider configuration
 */
export interface ProviderConfig {
  type: ProviderType;
  model?: string;
  endpoint?: string;
  model_path?: string;
  context_size?: number;
  gpu_layers?: number;
  priority: number;
  has_api_key: boolean;
  [key: string]: any; // Allow additional provider-specific parameters
}

/**
 * Provider configuration for orchestrator or workers
 */
export interface ProviderGroupConfig {
  providers: ProviderConfig[];
}

/**
 * Full configuration structure
 */
export interface Configuration {
  orchestrator: ProviderGroupConfig;
  workers: ProviderGroupConfig;
}

/**
 * Request to update configuration
 */
export interface UpdateConfigRequest {
  orchestrator?: {
    providers: Array<{
      type: string;
      model?: string;
      api_key?: string;
      endpoint?: string;
      model_path?: string;
      context_size?: number;
      gpu_layers?: number;
      priority: number;
      [key: string]: any;
    }>;
  };
  workers?: {
    providers: Array<{
      type: string;
      model?: string;
      api_key?: string;
      endpoint?: string;
      model_path?: string;
      context_size?: number;
      gpu_layers?: number;
      priority: number;
      [key: string]: any;
    }>;
  };
}

/**
 * Configuration validation result
 */
export interface ConfigValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  orchestrator_providers: number;
  worker_providers: number;
  timestamp: string;
}

/**
 * Configuration operation response
 */
export interface ConfigOperationResponse {
  status: 'success' | 'error';
  message: string;
  timestamp: string;
}

/**
 * Provider configuration form data (for UI)
 */
export interface ProviderFormData {
  type: ProviderType;
  model: string;
  apiKey: string;
  endpoint: string;
  modelPath: string;
  contextSize: number;
  gpuLayers: number;
  priority: number;
  extraParams: Record<string, any>;
}

/**
 * Provider template for common configurations
 */
export interface ProviderTemplate {
  id: string;
  name: string;
  description: string;
  type: ProviderType;
  defaultModel?: string;
  defaultEndpoint?: string;
  requiresApiKey: boolean;
  supportsCustomEndpoint: boolean;
  commonModels?: string[];
  documentation?: string;
}

/**
 * Common provider templates
 */
export const PROVIDER_TEMPLATES: ProviderTemplate[] = [
  {
    id: 'azure',
    name: 'Azure OpenAI / Azure Foundry',
    description: 'Microsoft Azure OpenAI Service or Azure Foundry',
    type: 'azure',
    // Browser traffic goes through the engine gateway (Azure Foundry direct).
    defaultEndpoint: '/api/engine/llm/chat',
    requiresApiKey: true,
    supportsCustomEndpoint: true,
    commonModels: ['deepseek-chat', 'gpt-4', 'gpt-4-turbo'],
    documentation: 'https://azure.microsoft.com/en-us/products/ai-services/openai-service',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'OpenAI API (GPT-4, GPT-3.5, etc.)',
    type: 'openai',
    requiresApiKey: true,
    supportsCustomEndpoint: false,
    commonModels: ['gpt-4-turbo-preview', 'gpt-4', 'gpt-3.5-turbo'],
    documentation: 'https://platform.openai.com/docs',
  },
  {
    id: 'groq',
    name: 'Groq',
    description: 'Groq - Ultra-fast LLM inference',
    type: 'groq',
    requiresApiKey: true,
    supportsCustomEndpoint: false,
    commonModels: [
      'llama-3.1-70b-versatile',
      'llama-3.1-8b-instant',
      'mixtral-8x7b-32768',
    ],
    documentation: 'https://groq.com',
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    description: 'Cerebras - Fastest LLM inference',
    type: 'cerebras',
    requiresApiKey: true,
    supportsCustomEndpoint: false,
    commonModels: ['llama3.1-8b', 'llama3.1-70b'],
    documentation: 'https://cerebras.ai',
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    description: 'NVIDIA NIM - Optimized model inference',
    type: 'nvidia',
    requiresApiKey: true,
    supportsCustomEndpoint: false,
    commonModels: ['meta/llama-3.1-8b-instruct', 'meta/llama-3.1-70b-instruct'],
    documentation: 'https://www.nvidia.com/en-us/ai-data-science/products/nim/',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    description: 'Google Gemini API',
    type: 'gemini',
    requiresApiKey: true,
    supportsCustomEndpoint: false,
    commonModels: ['gemini-1.5-pro', 'gemini-1.5-flash'],
    documentation: 'https://ai.google.dev/gemini-api',
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    description: 'Anthropic Claude API',
    type: 'anthropic',
    requiresApiKey: true,
    supportsCustomEndpoint: false,
    commonModels: [
      'claude-3-opus-20240229',
      'claude-3-sonnet-20240229',
      'claude-3-haiku-20240307',
    ],
    documentation: 'https://www.anthropic.com/api',
  },
  {
    id: 'ollama',
    name: 'Ollama',
    description: 'Ollama - Run LLMs locally or on cloud',
    type: 'ollama',
    defaultEndpoint: 'http://localhost:11434',
    requiresApiKey: false,
    supportsCustomEndpoint: true,
    commonModels: [
      'qwen2.5:72b',
      'qwen2.5:32b',
      'qwen2.5:14b',
      'llama3.1:70b',
      'llama3.1:8b',
    ],
    documentation: 'https://ollama.ai',
  },
  {
    id: 'lambo',
    name: 'LAMBO 2.1B (Local Swarm)',
    description: 'In-house 2.1B foundation model via Ollama / llama.cpp — 20 agents, 128k ctx, zero cloud tokens',
    type: 'lambo',
    defaultEndpoint: 'http://localhost:11434',
    requiresApiKey: false,
    supportsCustomEndpoint: true,
    commonModels: ['lambo-2.1b', 'lambo-2.1b-q4_k_m.gguf'],
    documentation: 'https://ollama.ai',
  },
  {
    id: 'custom',
    name: 'Custom OpenAI-Compatible',
    description: 'Any OpenAI-compatible API endpoint',
    type: 'custom',
    requiresApiKey: true,
    supportsCustomEndpoint: true,
    documentation: 'Use any OpenAI-compatible API',
  },
  {
    id: 'gguf',
    name: 'Local GGUF Model',
    description: 'Run local GGUF models via llama.cpp',
    type: 'gguf',
    requiresApiKey: false,
    supportsCustomEndpoint: false,
    documentation: 'https://github.com/ggerganov/llama.cpp',
  },
];

/**
 * Get provider template by type
 */
export function getProviderTemplate(type: ProviderType): ProviderTemplate | undefined {
  return PROVIDER_TEMPLATES.find((t) => t.type === type);
}

/**
 * Validate provider configuration
 */
export function validateProviderConfig(config: Partial<ProviderFormData>): string[] {
  const errors: string[] = [];

  if (!config.type) {
    errors.push('Provider type is required');
  }

  const template = config.type ? getProviderTemplate(config.type) : null;

  if (template) {
    if (template.requiresApiKey && !config.apiKey) {
      errors.push('API key is required for this provider');
    }

    if (template.supportsCustomEndpoint && config.endpoint && !isValidUrl(config.endpoint)) {
      errors.push('Invalid endpoint URL');
    }
  }

  if (config.type === 'gguf') {
    if (!config.modelPath) {
      errors.push('Model path is required for GGUF provider');
    }
  } else if (config.type !== 'provider_manager') {
    if (!config.model) {
      errors.push('Model name is required');
    }
  }

  if (config.priority !== undefined && (config.priority < 1 || config.priority > 100)) {
    errors.push('Priority must be between 1 and 100');
  }

  return errors;
}

/**
 * Check if string is valid URL
 */
function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create default provider configuration
 */
export function createDefaultProviderConfig(type: ProviderType): Partial<ProviderFormData> {
  const template = getProviderTemplate(type);

  return {
    type,
    model: template?.defaultModel || '',
    apiKey: '',
    endpoint: template?.defaultEndpoint || '',
    modelPath: '',
    contextSize: 8192,
    gpuLayers: 0,
    priority: 1,
    extraParams: {},
  };
}

// Made with Bob