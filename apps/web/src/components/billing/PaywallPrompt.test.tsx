import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import PaywallPrompt from "./PaywallPrompt";

// next/link renders a plain anchor in jsdom; keep it lightweight
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: any) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

afterEach(cleanup);

describe("PaywallPrompt", () => {
  it("renders inline variant with required/available credits when provided", () => {
    render(
      <PaywallPrompt variant="inline" creditsRequired={1.5} creditsAvailable={0.25} />,
    );
    expect(screen.getByText(/insufficient credits/i)).toBeInTheDocument();
    expect(screen.getByText(/1\.500 cr/)).toBeInTheDocument();
    expect(screen.getByText(/0\.250 cr/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /view plans/i })).toHaveAttribute("href", "/pricing");
  });

  it("renders generic out-of-credits body when amounts are omitted", () => {
    render(<PaywallPrompt variant="inline" />);
    expect(screen.getByText(/out of credits/i)).toBeInTheDocument();
  });

  it("modal variant wraps with overlay container", () => {
    const { container } = render(<PaywallPrompt variant="modal" />);
    expect(container.querySelector(".fixed.inset-0")).not.toBeNull();
  });

  it("calls onDismiss when Dismiss button is clicked", () => {
    const onDismiss = vi.fn();
    render(<PaywallPrompt variant="inline" onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("hides Dismiss button when onDismiss is not provided", () => {
    render(<PaywallPrompt variant="inline" />);
    expect(screen.queryByRole("button", { name: /dismiss/i })).toBeNull();
  });
});
