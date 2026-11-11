import { describe, it, expect, beforeEach } from 'vitest';
import {
  saveByokKey,
  getStoredByokKeys,
  getDecryptedKey,
  removeByokKey,
  clearMemoryVault,
} from './byokVault';

describe('byokVault', () => {
  beforeEach(() => {
    clearMemoryVault();
  });

  it('stores and decrypts API keys in client-side storage', () => {
    const rawKey = 'sk-ant-api03-test-secret-key-123456789';
    saveByokKey('anthropic', 'Anthropic Claude', rawKey);

    const keys = getStoredByokKeys();
    expect(keys.length).toBe(1);
    expect(keys[0].providerId).toBe('anthropic');
    expect(keys[0].keyPreview).toContain('sk-a');

    const decrypted = getDecryptedKey('anthropic');
    expect(decrypted).toBe(rawKey);
  });

  it('removes stored keys cleanly', () => {
    saveByokKey('openai', 'OpenAI', 'sk-proj-test1234');
    expect(getStoredByokKeys().length).toBe(1);

    removeByokKey('openai');
    expect(getStoredByokKeys().length).toBe(0);
    expect(getDecryptedKey('openai')).toBeNull();
  });
});
