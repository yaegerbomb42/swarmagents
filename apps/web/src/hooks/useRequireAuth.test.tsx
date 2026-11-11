import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";

const mockReplace = vi.fn();
const mockEnsureAuthListener = vi.fn();
const mockFetchMe = vi.fn();
const mockWaitForFirebaseUser = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
  usePathname: () => "/dashboard/live",
}));

vi.mock("@/lib/auth", () => ({
  ensureAuthListener: (...args: any[]) => mockEnsureAuthListener(...args),
  fetchMe: (...args: any[]) => mockFetchMe(...args),
  waitForFirebaseUser: () => mockWaitForFirebaseUser(),
}));

import { useRequireAuth } from "./useRequireAuth";

function Probe({ redirectTo }: { redirectTo?: string }) {
  const state = useRequireAuth(redirectTo);
  return <div data-testid="state">{state}</div>;
}

describe("useRequireAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnsureAuthListener.mockImplementation(() => undefined);
  });
  afterEach(cleanup);

  it("redirects to /login preserving `next` when no token", async () => {
    mockWaitForFirebaseUser.mockResolvedValue(null);
    render(<Probe />);
    await waitFor(() =>
      expect(screen.getByTestId("state").textContent).toBe("redirecting"),
    );
    expect(mockReplace).toHaveBeenCalledWith(
      `/login?next=${encodeURIComponent("/dashboard/live")}`,
    );
  });

  it("transitions to 'authed' with a valid token + /me ok", async () => {
    mockWaitForFirebaseUser.mockResolvedValue({ uid: "u1" });
    mockFetchMe.mockResolvedValue({ ok: true });
    render(<Probe />);
    await waitFor(() =>
      expect(screen.getByTestId("state").textContent).toBe("authed"),
    );
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("redirects when /me rejects the session", async () => {
    mockWaitForFirebaseUser.mockResolvedValue({ uid: "u1" });
    mockFetchMe.mockResolvedValue({ ok: false });
    render(<Probe />);
    await waitFor(() =>
      expect(screen.getByTestId("state").textContent).toBe("redirecting"),
    );
    expect(mockReplace).toHaveBeenCalledWith(
      `/login?next=${encodeURIComponent("/dashboard/live")}`,
    );
  });

  it("honors a custom redirectTo target", async () => {
    mockWaitForFirebaseUser.mockResolvedValue(null);
    render(<Probe redirectTo="/signin" />);
    await waitFor(() => expect(mockReplace).toHaveBeenCalled());
    expect(mockReplace.mock.calls[0][0]).toMatch(/^\/signin\?next=/);
  });
});
