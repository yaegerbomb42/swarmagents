/**
 * SWARMAGENTS - Cost Tracker
 * 
 * Tracks API costs per provider with real pricing data.
 */

// Pricing per 1 million tokens (input/output)
const PRICING = {
    deepseek: {
        name: 'DeepSeek V3.2 Speciale',
        input: 0.27,   // $0.27 per 1M input tokens
        output: 0.41,  // $0.41 per 1M output tokens
    },
    gpt5nano: {
        name: 'GPT-5 Nano',
        input: 0.10,   // Estimated Azure pricing
        output: 0.30,
    },
    groq: {
        name: 'Llama 4 Maverick (Groq)',
        input: 0.50,   // $0.50 per 1M input tokens
        output: 0.77,  // $0.77 per 1M output tokens
    },
    gemini: {
        name: 'Gemini 2.5 Pro',
        input: 1.25,   // Google AI pricing
        output: 5.00,
    },
    cerebras: {
        name: 'Llama 3.3 (Cerebras)',
        input: 0.10,
        output: 0.10,
    },
    ollama: {
        name: 'Ollama Cloud',
        input: 0.05,
        output: 0.10,
    },
    mistral: {
        name: 'Codestral (Mistral)',
        input: 0.30,
        output: 0.90,
    },
    openrouter: {
        name: 'OpenRouter (DeepSeek)',
        input: 0.27,
        output: 0.41,
    },
    azure: {
        name: 'Azure GPT-4o',
        input: 2.50,
        output: 10.00,
    },
};

class CostTracker {
    sessions: Map<string, any>;
    totalCost: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    callCount: number;
    startTime: number;
    costByProvider: Record<string, { cost: number; calls: number; tokens: number }>;
    costByAgent: Record<string, { cost: number; calls: number; tokens: number }>;

    constructor() {
        this.sessions = new Map();
        this.totalCost = 0;
        this.totalInputTokens = 0;
        this.totalOutputTokens = 0;
        this.callCount = 0;
        this.startTime = Date.now();
        this.costByProvider = {};
        this.costByAgent = {};
    }

    /**
     * Track a completed LLM call
     */
    track(provider, inputTokens, outputTokens, agentId = null) {
        const pricing = PRICING[provider] || { input: 0.50, output: 0.50 };

        // Calculate cost (pricing is per 1M tokens)
        const inputCost = (inputTokens / 1_000_000) * pricing.input;
        const outputCost = (outputTokens / 1_000_000) * pricing.output;
        const totalCost = inputCost + outputCost;

        // Update totals
        this.totalCost += totalCost;
        this.totalInputTokens += inputTokens;
        this.totalOutputTokens += outputTokens;
        this.callCount++;

        // Track by provider
        if (!this.costByProvider[provider]) {
            this.costByProvider[provider] = { cost: 0, calls: 0, tokens: 0 };
        }
        this.costByProvider[provider].cost += totalCost;
        this.costByProvider[provider].calls++;
        this.costByProvider[provider].tokens += inputTokens + outputTokens;

        // Track by agent
        if (agentId) {
            if (!this.costByAgent[agentId]) {
                this.costByAgent[agentId] = { cost: 0, calls: 0, tokens: 0 };
            }
            this.costByAgent[agentId].cost += totalCost;
            this.costByAgent[agentId].calls++;
            this.costByAgent[agentId].tokens += inputTokens + outputTokens;
        }

        return {
            inputCost,
            outputCost,
            totalCost,
            runningTotal: this.totalCost,
        };
    }

    /**
     * Get current stats
     */
    getStats() {
        const runtime = (Date.now() - this.startTime) / 1000; // seconds

        return {
            totalCost: this.totalCost,
            totalCostFormatted: `$${this.totalCost.toFixed(4)}`,
            totalInputTokens: this.totalInputTokens,
            totalOutputTokens: this.totalOutputTokens,
            totalTokens: this.totalInputTokens + this.totalOutputTokens,
            callCount: this.callCount,
            runtimeSeconds: runtime,
            runtimeFormatted: this.formatRuntime(runtime),
            costPerMinute: runtime > 0 ? (this.totalCost / (runtime / 60)) : 0,
            tokensPerMinute: runtime > 0 ? ((this.totalInputTokens + this.totalOutputTokens) / (runtime / 60)) : 0,
            byProvider: this.costByProvider,
            byAgent: this.costByAgent,
        };
    }

    formatRuntime(seconds) {
        const hrs = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);

        if (hrs > 0) {
            return `${hrs}h ${mins}m ${secs}s`;
        } else if (mins > 0) {
            return `${mins}m ${secs}s`;
        }
        return `${secs}s`;
    }

    /**
     * Get pricing info for display
     */
    static getPricingInfo() {
        return PRICING;
    }

    /**
     * Reset stats
     */
    reset() {
        this.totalCost = 0;
        this.totalInputTokens = 0;
        this.totalOutputTokens = 0;
        this.callCount = 0;
        this.startTime = Date.now();
        this.costByProvider = {};
        this.costByAgent = {};
    }
}

// Singleton
let instance = null;

export function getCostTracker() {
    if (!instance) {
        instance = new CostTracker();
    }
    return instance;
}

export { CostTracker, PRICING };
export default getCostTracker;
