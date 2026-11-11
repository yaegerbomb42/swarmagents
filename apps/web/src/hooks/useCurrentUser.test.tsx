import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  ensureAuthListener: vi.fn(),
  fetchMe: vi.fn(),
  getStoredUser: vi.fn(),
  getToken: vi.fn(),
  isFirebaseConfigured: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  ensureAuthListener: mocks.ensureAuthListener,
  fetchMe: mocks.fetchMe,
  getStoredUser: mocks.getStoredUser,
  getToken: mocks.getToken,
}));

vi.mock('@/lib/firebase', () => ({
  isFirebaseConfigured: mocks.isFirebaseConfigured,
}));

import { useCurrentUser } from './useCurrentUser';

describe('useCurrentUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the cached session user synchronously and validates via fetchMe', async () => {
    const user = { id: 'usr-1', email: 'ada@example.com', display_name: 'Ada' };
    mocks.getToken.mockReturnValue('token-123');
    mocks.getStoredUser.mockReturnValue(user);
    mocks.isFirebaseConfigured.mockReturnValue(true);
    mocks.fetchMe.mockResolvedValue({ ok: true, data: user });

    const { result } = renderHook(() => useCurrentUser());

    // Synchronous cache hit — no waiting required
    expect(result.current).toEqual(user);

    await waitFor(() => expect(mocks.fetchMe).toHaveBeenCalled());
    expect(mocks.ensureAuthListener).toHaveBeenCalled();
    expect(result.current).toEqual(user);
  });

  it('returns null when signed out and skips fetchMe when Firebase is unconfigured', () => {
    mocks.getToken.mockReturnValue(null);
    mocks.getStoredUser.mockReturnValue(null);
    mocks.isFirebaseConfigured.mockReturnValue(false);

    const { result } = renderHook(() => useCurrentUser());

    expect(result.current).toBeNull();
    expect(mocks.fetchMe).not.toHaveBeenCalled();
  });

  it('adopts the validated identity when fetchMe resolves a different user', async () => {
    mocks.getToken.mockReturnValue('token-123');
    mocks.getStoredUser.mockReturnValue(null);
    mocks.isFirebaseConfigured.mockReturnValue(true);
    const fresh = { id: 'usr-2', email: 'grace@example.com' };
    mocks.fetchMe.mockResolvedValue({ ok: true, data: fresh });

    const { result } = renderHook(() => useCurrentUser());

    await waitFor(() => expect(result.current).toEqual(fresh));
  });

  it('falls back to the cached user when fetchMe fails', async () => {
    const cached = { id: 'usr-1', email: 'ada@example.com' };
    mocks.getToken.mockReturnValue('token-123');
    mocks.getStoredUser.mockReturnValue(cached);
    mocks.isFirebaseConfigured.mockReturnValue(true);
    mocks.fetchMe.mockRejectedValue(new Error('network down'));

    const { result } = renderHook(() => useCurrentUser());

    await waitFor(() => expect(mocks.fetchMe).toHaveBeenCalled());
    expect(result.current).toEqual(cached);
  });
});
