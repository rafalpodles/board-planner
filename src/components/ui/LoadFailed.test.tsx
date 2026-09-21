// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { LoadFailed } from "./LoadFailed";

afterEach(cleanup);

describe("LoadFailed", () => {
  // The failure has to be announced, not only drawn — three of these screens toasted and the
  // toast was gone in three seconds (BP-577)
  it("is an alert region carrying both the message and the Retry", () => {
    render(<LoadFailed message="Failed to load the audit log." onRetry={vi.fn()} />);

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Failed to load the audit log.");
    expect(alert.querySelector("button")?.textContent).toBe("Retry");
  });

  // A refusal reads the same on every retry, so a button offering one says the page is broken
  it("offers no Retry when there is nothing a retry could change", () => {
    render(<LoadFailed message="You do not have access to this board." />);

    expect(screen.getByRole("alert").textContent).toContain("You do not have access to this board.");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("calls onRetry when the button is pressed", () => {
    const onRetry = vi.fn();
    render(<LoadFailed message="Failed." onRetry={onRetry} />);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
