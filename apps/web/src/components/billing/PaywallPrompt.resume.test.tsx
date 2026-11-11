import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import PaywallPrompt from "./PaywallPrompt";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: any) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

afterEach(cleanup);

describe("PaywallPrompt resume-path", () => {
  it("modal renders deficit amounts and buy-credits deep link for resume-on-topup", () => {
    render(
      <PaywallPrompt variant="modal" creditsRequired={4.25} creditsAvailable={0.1} />,
    );
    expect(screen.getByText(/insufficient credits/i)).toBeInTheDocument();
    // deficit copy lets the user know exactly how much to top up before resuming
    expect(screen.getByText(/4\.250 cr/)).toBeInTheDocument();
    expect(screen.getByText(/0\.100 cr/)).toBeInTheDocument();
    const cta = screen.getByRole("link", { name: /view plans/i });
    expect(cta).toHaveAttribute("href", "/pricing");
  });

  it("dismiss in modal keeps UI usable while user tops up in another tab", () => {
    const onDismiss = vi.fn();
    render(<PaywallPrompt variant="modal" onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
