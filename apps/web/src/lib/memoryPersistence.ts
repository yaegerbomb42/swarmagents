/**
 * SWARMAGENTS - Memory Persistence
 *
 * Save and restore agent state to disk.
 */

import fs from 'fs/promises';
import path from 'path';

const PERSISTENCE_DIR = process.env.SWARMAGENTS_DATA_DIR || '.swarmagents-data';

class MemoryPersistence {
    private dir: string;
    private initialized: boolean;

    constructor() {
        this.dir = PERSISTENCE_DIR;
        this.initialized = false;
    }

    async init() {
        if (this.initialized) return;

        try {
            await fs.mkdir(this.dir, { recursive: true });
            this.initialized = true;
        } catch (error) {
            console.error('Failed to create persistence directory:', error);
        }
    }

    /**
     * Save orchestrator state
     */
    async saveState(orchestrator) {
        await this.init();

        const state = {
            version: 1,
            savedAt: new Date().toISOString(),
            orchestrator: orchestrator.serialize(),
        };

        const filePath = path.join(this.dir, 'state.json');
        await fs.writeFile(filePath, JSON.stringify(state, null, 2));

        return { saved: true, path: filePath };
    }

    /**
     * Load orchestrator state
     */
    async loadState() {
        await this.init();

        const filePath = path.join(this.dir, 'state.json');

        try {
            const data = await fs.readFile(filePath, 'utf-8');
            return JSON.parse(data);
        } catch (error) {
            if (error.code === 'ENOENT') {
                return null; // No saved state
            }
            throw error;
        }
    }

    /**
     * Save shared memory
     */
    async saveMemory(sharedMemory) {
        await this.init();

        const data = {};
        const keys = await sharedMemory.keys();

        for (const key of keys) {
            data[key] = await sharedMemory.get(key);
        }

        const filePath = path.join(this.dir, 'memory.json');
        await fs.writeFile(filePath, JSON.stringify({
            version: 1,
            savedAt: new Date().toISOString(),
            memory: data,
        }, null, 2));

        return { saved: true, entries: keys.length };
    }

    /**
     * Load shared memory
     */
    async loadMemory(sharedMemory) {
        await this.init();

        const filePath = path.join(this.dir, 'memory.json');

        try {
            const raw = await fs.readFile(filePath, 'utf-8');
            const data = JSON.parse(raw);

            if (data.memory) {
                for (const [key, value] of Object.entries(data.memory)) {
                    await sharedMemory.set(key, value);
                }
            }

            return { loaded: true, entries: Object.keys(data.memory || {}).length };
        } catch (error) {
            if (error.code === 'ENOENT') {
                return { loaded: false, reason: 'no saved memory' };
            }
            throw error;
        }
    }

    /**
     * Save cost tracking data
     */
    async saveCosts(costTracker) {
        await this.init();

        const filePath = path.join(this.dir, 'costs.json');
        await fs.writeFile(filePath, JSON.stringify({
            version: 1,
            savedAt: new Date().toISOString(),
            stats: costTracker.getStats(),
        }, null, 2));

        return { saved: true };
    }

    /**
     * Save learning data
     */
    async saveLearning(learningSystem) {
        await this.init();

        const lessons = await learningSystem.getLessons();
        const filePath = path.join(this.dir, 'learning.json');

        await fs.writeFile(filePath, JSON.stringify({
            version: 1,
            savedAt: new Date().toISOString(),
            lessons,
        }, null, 2));

        return { saved: true, lessons: lessons.length };
    }

    /**
     * Auto-save everything periodically
     */
    startAutoSave(orchestrator, interval = 60000) {
        setInterval(async () => {
            try {
                await this.saveState(orchestrator);
                console.log('💾 Auto-saved state');
            } catch (error) {
                console.error('Auto-save failed:', error.message);
            }
        }, interval);
    }
}

// Singleton
let instance = null;

export function getMemoryPersistence() {
    if (!instance) {
        instance = new MemoryPersistence();
    }
    return instance;
}

export { MemoryPersistence };
export default getMemoryPersistence;
