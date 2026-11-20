import { describe, expect, it } from 'vitest';
import {
  CacheMeter,
  fromAnthropic,
  fromOpenAI,
  fromDeepSeek,
} from '../../../src/telemetry/cache-meter.js';

describe('CacheMeter', () => {
  describe('recordTurn', () => {
    it('records turn usage', () => {
      const meter = new CacheMeter();
      meter.recordTurn({ promptTokens: 100, cachedPromptTokens: 50 });
      expect(meter.promptTotal).toBe(100);
      expect(meter.cachedTotal).toBe(50);
    });

    it('defaults missing fields to zero', () => {
      const meter = new CacheMeter();
      meter.recordTurn({ promptTokens: 100 });
      expect(meter.cachedTotal).toBe(0);
      expect(meter.readCacheTotal).toBe(0);
      expect(meter.writeCacheTotal).toBe(0);
    });
  });

  describe('fromAnthropic', () => {
    it('creates TurnUsage from Anthropic format', () => {
      const usage = fromAnthropic(100, 50);
      expect(usage).toEqual({ promptTokens: 100, cachedPromptTokens: 50 });
    });

    it('handles undefined cache read', () => {
      const usage = fromAnthropic(100);
      expect(usage).toEqual({ promptTokens: 100, cachedPromptTokens: undefined });
    });
  });

  describe('fromOpenAI', () => {
    it('creates TurnUsage from OpenAI format', () => {
      const usage = fromOpenAI(100, 30);
      expect(usage).toEqual({ promptTokens: 100, cachedPromptTokens: 30 });
    });
  });

  describe('fromDeepSeek', () => {
    it('creates TurnUsage from DeepSeek format', () => {
      const usage = fromDeepSeek(100, 30, 10);
      expect(usage).toEqual({ promptTokens: 100, cachedPromptTokens: 30, readCacheTokens: 10 });
    });

    it('handles optional fields', () => {
      const usage = fromDeepSeek(100);
      expect(usage).toEqual({
        promptTokens: 100,
        cachedPromptTokens: undefined,
        readCacheTokens: undefined,
      });
    });
  });

  describe('getTurnRatio', () => {
    it('returns 0 when no prompts recorded', () => {
      const meter = new CacheMeter();
      expect(meter.getTurnRatio()).toBe(0);
    });

    it('calculates cached-to-prompt ratio', () => {
      const meter = new CacheMeter();
      meter.recordTurn({ promptTokens: 100, cachedPromptTokens: 50 });
      meter.recordTurn({ promptTokens: 200, cachedPromptTokens: 100 });
      expect(meter.getTurnRatio()).toBe(150 / 300);
    });

    it('handles mixed turns', () => {
      const meter = new CacheMeter();
      meter.recordTurn({ promptTokens: 100, cachedPromptTokens: 50 });
      meter.recordTurn({ promptTokens: 200 }); // no cached
      expect(meter.getTurnRatio()).toBe(50 / 300);
    });
  });

  describe('getSessionStats', () => {
    it('returns session stats', () => {
      const meter = new CacheMeter();
      meter.recordTurn({ promptTokens: 100, cachedPromptTokens: 50 });
      meter.recordTurn({ promptTokens: 200, cachedPromptTokens: 100 });
      const stats = meter.getSessionStats();
      expect(stats.totalPrompt).toBe(300);
      expect(stats.totalCached).toBe(150);
      expect(stats.overallHitRatio).toBe(150 / 300);
      expect(typeof stats.estimatedDollarSavings).toBe('number');
    });

    it('handles empty session', () => {
      const meter = new CacheMeter();
      const stats = meter.getSessionStats();
      expect(stats.totalPrompt).toBe(0);
      expect(stats.totalCached).toBe(0);
      expect(stats.overallHitRatio).toBe(0);
      expect(stats.estimatedDollarSavings).toBe(0);
    });
  });
});
