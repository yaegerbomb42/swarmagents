/**
 * SWARMAGENTS - State Persistence System
 *
 * "Memory is the thread of consciousness."
 *
 * Handles atomic saving and loading of the agent's complete state
 * to ensure survivability across process restarts and crashes.
 */

import fs from 'fs/promises';
import path from 'path';

const STATE_FILE = '.swarmagents_state.json';
const BACKUP_FILE = '.swarmagents_state.bak';

export class StateManager {
    private statePath: string;
    private backupPath: string;

    constructor(baseDir = process.cwd()) {
        this.statePath = path.join(baseDir, STATE_FILE);
        this.backupPath = path.join(baseDir, BACKUP_FILE);
    }

    /**
     * Atomically save the entire agent state
     */
    async saveState(agent) {
        if (!agent.running && agent.state === 'idle') return;

        const state = {
            id: agent.id,
            timestamp: Date.now(),
            iteration: agent.iteration,
            goal: agent.currentGoal,
            prompt: agent.currentPrompt,
            plan: agent.currentPlan,
            completedSteps: agent.completedSteps,
            metrics: agent.metrics,
            // We don't save the full memory object here as it has its own persistence,
            // but we save the pointer/context if needed.
            memoryContext: {
                activeContext: agent.activeContext
            }
        };

        try {
            const data = JSON.stringify(state, null, 2);

            // Write to backup first if exists
            try {
                await fs.copyFile(this.statePath, this.backupPath);
            } catch (e) {
                // No existing state to backup, ignore
            }

            // Write new state
            await fs.writeFile(this.statePath, data, 'utf8');
            // console.log('⚡ State saved.');
        } catch (error) {
            console.error('Failed to save state:', error);
        }
    }

    /**
     * Load state from disk
     */
    async loadState() {
        try {
            const data = await fs.readFile(this.statePath, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            if (error.code === 'ENOENT') return null;

            console.warn('Corrupt state file, trying backup...');
            try {
                const backup = await fs.readFile(this.backupPath, 'utf8');
                return JSON.parse(backup);
            } catch (backupError) {
                return null;
            }
        }
    }

    /**
     * Clear state (on explicit stop/reset)
     */
    async clearState() {
        try {
            await fs.unlink(this.statePath);
            await fs.unlink(this.backupPath);
        } catch (e) {
            // Ignore
        }
    }
}
