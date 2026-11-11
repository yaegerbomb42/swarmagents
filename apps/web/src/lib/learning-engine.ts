// Online Learning Engine - RAG-based continual learning
import type { ConversationTurn, VectorDocument, LearningConfig, LearningContext, LearningStats } from '@/types/learning';

// Simple in-memory vector store (can be replaced with Chroma/FAISS later)
class InMemoryVectorStore {
  private documents: Map<string, VectorDocument> = new Map();
  private embeddings: Map<string, number[]> = new Map();

  async addDocument(doc: VectorDocument): Promise<void> {
    this.documents.set(doc.id, doc);
    // For now, use simple keyword matching as embedding placeholder
    // In production, use sentence-transformers or OpenAI embeddings
    this.embeddings.set(doc.id, this.simpleEmbedding(doc.content));
  }

  async search(query: string, topK: number = 5): Promise<VectorDocument[]> {
    const queryEmbedding = this.simpleEmbedding(query);
    const results: { doc: VectorDocument; score: number }[] = [];

    for (const [id, embedding] of this.embeddings.entries()) {
      const doc = this.documents.get(id);
      if (!doc) continue;
      const score = this.cosineSimilarity(queryEmbedding, embedding);
      results.push({ doc, score });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK).map(r => r.doc);
  }

  async deleteDocument(id: string): Promise<void> {
    this.documents.delete(id);
    this.embeddings.delete(id);
  }

  async clear(): Promise<void> {
    this.documents.clear();
    this.embeddings.clear();
  }

  private simpleEmbedding(text: string): number[] {
    // Placeholder: simple character frequency vector
    // In production, use proper embeddings
    const vector = new Array(64).fill(0);
    const words = text.toLowerCase().split(/\s+/);
    for (const word of words) {
      const hash = this.simpleHash(word);
      vector[hash % 64] += 1;
    }
    return vector;
  }

  private simpleHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
  }
}

export class LearningEngine {
  private vectorStore: InMemoryVectorStore;
  private conversations: ConversationTurn[] = [];
  private config: LearningConfig;
  private stats: LearningStats;

  constructor(config?: Partial<LearningConfig>) {
    this.vectorStore = new InMemoryVectorStore();
    this.config = {
      mode: 'rag',
      ragEnabled: true,
      ragTopK: 3,
      ragMinSimilarity: 0.3,
      qloraEnabled: false,
      qloraSchedule: 'idle',
      userOptIn: true,
      maxStoredConversations: 10000,
      ...config,
    };
    this.stats = {
      totalConversations: 0,
      totalTrainingSamples: 0,
      ragQueries: 0,
      qloraTrainingRuns: 0,
      modelVersion: '1.0.0',
    };
  }

  // Log a conversation turn
  async logConversation(turn: Omit<ConversationTurn, 'id' | 'timestamp'>): Promise<string> {
    if (!this.config.userOptIn) {
      throw new Error('User has opted out of learning');
    }

    const id = crypto.randomUUID();
    const conversation: ConversationTurn = {
      ...turn,
      id,
      timestamp: Date.now(),
    };

    this.conversations.push(conversation);
    this.stats.totalConversations++;

    // Add to vector store for RAG
    await this.vectorStore.addDocument({
      id: `conv-${id}`,
      content: `User: ${turn.userPrompt}\nAssistant: ${turn.modelResponse}`,
      metadata: {
        timestamp: conversation.timestamp,
        taskType: turn.taskType,
        success: turn.success,
        userId: turn.userId,
      },
    });

    // Prune old conversations if exceeding limit
    if (this.conversations.length > this.config.maxStoredConversations) {
      const removed = this.conversations.shift();
      if (removed) {
        await this.vectorStore.deleteDocument(`conv-${removed.id}`);
      }
    }

    return id;
  }

  // Retrieve relevant context for RAG
  async retrieveContext(query: string): Promise<LearningContext> {
    if (!this.config.ragEnabled) {
      return { relevantConversations: [], augmentedPrompt: query, retrievalTime: 0 };
    }

    const startTime = Date.now();
    const docs = await this.vectorStore.search(query, this.config.ragTopK);
    this.stats.ragQueries++;

    const relevantConversations: ConversationTurn[] = [];
    let contextText = '';

    for (const doc of docs) {
      const conv = this.conversations.find(c => `conv-${c.id}` === doc.id);
      if (conv) {
        relevantConversations.push(conv);
        contextText += `\n--- Previous Interaction ---\nUser: ${conv.userPrompt}\nAssistant: ${conv.modelResponse}\n`;
      }
    }

    const augmentedPrompt = contextText
      ? `${contextText}\n--- Current Request ---\n${query}`
      : query;

    return {
      relevantConversations,
      augmentedPrompt,
      retrievalTime: Date.now() - startTime,
    };
  }

  // Mark a conversation as successful/failed (user feedback)
  async markConversationSuccess(id: string, success: boolean): Promise<void> {
    const conv = this.conversations.find(c => c.id === id);
    if (conv) {
      conv.success = success;
      // Update vector store metadata
      const doc = await this.vectorStore.search(`User: ${conv.userPrompt}`, 1);
      if (doc.length > 0) {
        await this.vectorStore.deleteDocument(`conv-${id}`);
        await this.vectorStore.addDocument({
          id: `conv-${id}`,
          content: `User: ${conv.userPrompt}\nAssistant: ${conv.modelResponse}`,
          metadata: {
            ...doc[0].metadata,
            success,
          },
        });
      }
    }
  }

  // Export training samples for QLoRA
  exportTrainingSamples(): string {
    const samples = this.conversations
      .filter(c => c.success !== false) // Exclude failed interactions
      .map(c => ({
        instruction: c.userPrompt,
        output: c.modelResponse,
        task_type: c.taskType || 'general',
      }));

    return JSON.stringify(samples, null, 2);
  }

  // Get learning statistics
  getStats(): LearningStats {
    return {
      ...this.stats,
      totalConversations: this.conversations.length,
    };
  }

  // Update configuration
  updateConfig(updates: Partial<LearningConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  // Get current configuration
  getConfig(): LearningConfig {
    return { ...this.config };
  }

  // Clear all learning data
  async clearAll(): Promise<void> {
    this.conversations = [];
    await this.vectorStore.clear();
    this.stats = {
      totalConversations: 0,
      totalTrainingSamples: 0,
      ragQueries: 0,
      qloraTrainingRuns: 0,
      modelVersion: '1.0.0',
    };
  }

  // Delete specific conversation
  async deleteConversation(id: string): Promise<void> {
    const index = this.conversations.findIndex(c => c.id === id);
    if (index !== -1) {
      this.conversations.splice(index, 1);
      await this.vectorStore.deleteDocument(`conv-${id}`);
    }
  }
}

// Singleton instance
let learningEngine: LearningEngine | null = null;

export function getLearningEngine(): LearningEngine {
  if (!learningEngine) {
    learningEngine = new LearningEngine();
  }
  return learningEngine;
}
