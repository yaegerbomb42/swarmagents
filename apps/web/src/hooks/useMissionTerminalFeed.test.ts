import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMissionTerminalFeed } from './useMissionTerminalFeed';

describe('useMissionTerminalFeed', () => {
  it('appends mission log lines', () => {
    const { result } = renderHook(() => useMissionTerminalFeed(null, null));
    act(() => {
      result.current.append('system', 'mission started');
    });
    expect(result.current.lines.some((l) => l.text === 'mission started')).toBe(true);
  });
});
