// Online Learning System Types

export interface ConversationTurn {
  id: string;
  timestamp: number;
  userId?: string;
  sessionId: string;
  userPrompt: string;
  modelResponse: string;
  taskType?: string;
  success?: boolean; // User feedback
  metadata?: Record<string, unknown>;
}

export interface TrainingSample {
  id: string;
  prompt: string;
  response: string;
  taskType?: string;
  cognitiveMode?: string;
  timestamp: number;
  source: 'user' | 'synthetic' | 'replay';
}

export interface VectorDocument {
  id: string;
  content: string;
  embedding?: number[];
  metadata: {
    timestamp: number;
    taskType?: string;
    success?: boolean;
    userId?: string;
  };
}

export interface LearningConfig {
  mode: 'rag' | 'qlora' | 'hybrid';
  ragEnabled: boolean;
  ragTopK: number;
  ragMinSimilarity: number;
  qloraEnabled: boolean;
  qloraSchedule: 'idle' | 'nightly' | 'manual';
  userOptIn: boolean;
  maxStoredConversations: number;
}

export interface LearningStats {
  totalConversations: number;
  totalTrainingSamples: number;
  ragQueries: number;
  qloraTrainingRuns: number;
  lastTrainingTime?: number;
  modelVersion: string;
}

export interface LearningContext {
  relevantConversations: ConversationTurn[];
  augmentedPrompt: string;
  retrievalTime: number;
}
