import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

vi.mock("@/lib/billingClient", () => ({
  fetchBalance: vi.fn(),
}));

import { renderHook, act, cleanup, waitFor } from "@testing-library/react";
import { fetchBalance } from "@/lib/billingClient";
import { useBalance, requestBalanceRefresh } from "./useBalance";

const mockFetch = fetchBalance as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(cleanup);

describe("useBalance", () => {
  it("fetches balance on mount and exposes refresh()", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      data: { user_id: "u1", credits: 42, free_grant_used: false, free_grant_available: true },
    });
    const { result } = renderHook(() => useBalance({ intervalMs: 0 }));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.balance?.credits).toBe(42);

    mockFetch.mockResolvedValue({
      ok: true,
      data: { user_id: "u1", credits: 100, free_grant_used: true, free_grant_available: false },
    });
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.balance?.credits).toBe(100);
  });

  it("refetches when the global balance-refresh event fires (post-execution)", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      data: { user_id: "u1", credits: 10, free_grant_used: false, free_grant_available: true },
    });
    const { result } = renderHook(() => useBalance({ intervalMs: 0 }));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(mockFetch).toHaveBeenCalledTimes(1);

    mockFetch.mockResolvedValue({
      ok: true,
      data: { user_id: "u1", credits: 7.5, free_grant_used: false, free_grant_available: true },
    });
    await act(async () => {
      requestBalanceRefresh();
    });
    await waitFor(() => expect(result.current.balance?.credits).toBe(7.5));
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("marks balance unavailable on auth failure (renders nothing downstream)", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      error: { error: "unauthorized" },
    });
    const { result } = renderHook(() => useBalance({ intervalMs: 0 }));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.balance).toBeNull();
    expect(result.current.unavailable).toBe(true);
  });
});
