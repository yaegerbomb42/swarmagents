/**
 * SWARMAGENTS - Learning System
 *
 * Agents learn from past mistakes and successes.
 */

import { getSharedMemory } from '../agent/memory';

interface Lesson {
    id: string;
    type: string;
    category: string;
    problem: string;
    solution: string;
    context: any;
    agentId?: string;
    timestamp: string;
    useCount: number;
    lastUsed?: string;
}

type MemoryStore = {
    get: (key: string) => Promise<any>;
    set: (key: string, value: unknown) => Promise<Map<string, unknown>>;
    has: (key: string) => Promise<boolean>;
    delete: (key: string) => Promise<boolean>;
    keys: () => Promise<string[]>;
};

class LearningSystem {
    private store: MemoryStore;

    constructor() {
        this.store = getSharedMemory();
    }

    /**
     * Record a lesson learned (from error or success)
     */
    async recordLesson(lesson) {
        const lessons = (await this.getLessons()) || [];

        const newLesson = {
            id: `lesson-${Date.now()}`,
            type: lesson.type || 'error', // 'error', 'success', 'pattern'
            category: lesson.category || 'general',
            problem: lesson.problem,
            solution: lesson.solution,
            context: lesson.context,
            agentId: lesson.agentId,
            timestamp: new Date().toISOString(),
            useCount: 0,
        };

        lessons.push(newLesson);
        await this.store.set('learning:lessons', { value: lessons });

        return newLesson;
    }

    /**
     * Record an error and how it was fixed
     */
    async recordErrorFix(error, fix, context = {}) {
        return this.recordLesson({
            type: 'error',
            category: this.categorizeError(error),
            problem: error,
            solution: fix,
            context,
        });
    }

    /**
     * Record a successful pattern
     */
    async recordSuccess(pattern, outcome, context = {}) {
        return this.recordLesson({
            type: 'success',
            category: 'pattern',
            problem: `How to: ${pattern}`,
            solution: outcome,
            context,
        });
    }

    /**
     * Get all lessons
     */
    async getLessons() {
        const entry = await this.store.get('learning:lessons');
        return entry?.value || [];
    }

    /**
     * Search for relevant lessons
     */
    async findRelevantLessons(query, limit = 5) {
        const lessons = await this.getLessons();
        const queryLower = query.toLowerCase();

        // Simple keyword matching (could be upgraded to embeddings)
        const scored = lessons.map(lesson => {
            let score = 0;
            const text = `${lesson.problem} ${lesson.solution} ${lesson.category}`.toLowerCase();

            const words = queryLower.split(/\s+/);
            for (const word of words) {
                if (text.includes(word)) score++;
            }

            return { lesson, score };
        });

        return scored
            .filter(s => s.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map(s => s.lesson);
    }

    /**
     * Get lessons as context for agent
     */
    async getLessonsForContext(category = null) {
        const lessons = await this.getLessons();
        const filtered = category
            ? lessons.filter(l => l.category === category)
            : lessons;

        // Return most recent and most used
        const sorted = filtered.sort((a, b) => {
            // Prioritize by use count, then recency
            if (b.useCount !== a.useCount) return b.useCount - a.useCount;
            return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
        });

        return sorted.slice(0, 10);
    }

    /**
     * Mark a lesson as used (increases priority)
     */
    async markLessonUsed(lessonId) {
        const lessons = await this.getLessons();
        const lesson = lessons.find(l => l.id === lessonId);
        if (lesson) {
            lesson.useCount++;
            lesson.lastUsed = new Date().toISOString();
            await this.store.set('learning:lessons', { value: lessons });
        }
    }

    /**
     * Categorize an error message
     */
    categorizeError(error) {
        const errorLower = error.toLowerCase();

        if (errorLower.includes('syntax') || errorLower.includes('unexpected token')) {
            return 'syntax';
        }
        if (errorLower.includes('module') || errorLower.includes('import') || errorLower.includes('require')) {
            return 'import';
        }
        if (errorLower.includes('undefined') || errorLower.includes('null')) {
            return 'null-reference';
        }
        if (errorLower.includes('type') && errorLower.includes('error')) {
            return 'type';
        }
        if (errorLower.includes('network') || errorLower.includes('fetch') || errorLower.includes('api')) {
            return 'network';
        }
        if (errorLower.includes('permission') || errorLower.includes('access')) {
            return 'permission';
        }
        if (errorLower.includes('git') || errorLower.includes('commit') || errorLower.includes('push')) {
            return 'git';
        }
        if (errorLower.includes('npm') || errorLower.includes('package')) {
            return 'package';
        }

        return 'general';
    }

    /**
     * Get stats about learning
     */
    async getStats() {
        const lessons = await this.getLessons();

        const byCategory = {};
        const byType = { error: 0, success: 0, pattern: 0 };

        for (const lesson of lessons) {
            byCategory[lesson.category] = (byCategory[lesson.category] || 0) + 1;
            byType[lesson.type] = (byType[lesson.type] || 0) + 1;
        }

        return {
            totalLessons: lessons.length,
            byCategory,
            byType,
            mostUsed: lessons.sort((a, b) => b.useCount - a.useCount).slice(0, 5),
        };
    }
}

// Singleton
let instance = null;

export function getLearningSystem() {
    if (!instance) {
        instance = new LearningSystem();
    }
    return instance;
}

export { LearningSystem };
export default getLearningSystem;
