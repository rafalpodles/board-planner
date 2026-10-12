// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ConfirmDialog } from "./ConfirmDialog";

afterEach(cleanup);

// BP-1033. The message is often the whole point (a count of people who would be locked out), and a
// dialog named only by its title leaves it for the reader to go and find.
describe("ConfirmDialog", () => {
  const base = { open: true, onClose: vi.fn(), onConfirm: vi.fn() };

  it("is described by its message, after its title", () => {
    render(
      <ConfirmDialog {...base} title="Remove 3 members?" message="They will be locked out of the board." />
    );

    expect(
      screen.getByRole("dialog", {
        name: "Remove 3 members?",
        description: "They will be locked out of the board.",
      })
    ).toBeTruthy();
  });

  it("keeps a failure out of the description, where it is its own alert", () => {
    render(
      <ConfirmDialog
        {...base}
        title="Delete board?"
        message="Its tasks go with it."
        error="Could not delete."
      />
    );

    expect(screen.getByRole("dialog", { description: "Its tasks go with it." })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Could not delete.");
  });
});
