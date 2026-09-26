// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen, act } from "@testing-library/react";
import { SaveBar } from "./SaveBar";

/**
 * BP-593. The PM launcher is painted over this bar and steps up for anything declaring the bottom
 * strip. Unlike the phone comment bar, this one is always mounted and collapses to `max-h-0`, so
 * it may only declare the strip while it is open — otherwise the launcher would sit raised on
 * every settings page for ever. The launcher's own half is asserted in `PmChatWidget.test.tsx`.
 */

vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const group = {
  id: "general",
  section: "general",
  label: "General",
  count: 1,
  save: vi.fn(),
  discard: vi.fn(),
};

const bar = () => document.querySelector("[data-pinned-bottom-bar]");

afterEach(cleanup);

describe("SaveBar and the strip below it", () => {
  it("declares the bottom strip while it is open", () => {
    render(<SaveBar pending={[group]} total={1} onGoToSection={vi.fn()} />);

    expect(bar()).not.toBeNull();
  });

  // The reason it is conditional: the bar never unmounts, it collapses
  it("declares nothing once there is nothing to save", () => {
    render(<SaveBar pending={[]} total={0} onGoToSection={vi.fn()} />);

    expect(bar()).toBeNull();
  });
});

// BP-783: split, a narrow bar kept Discard at the right of its top row, under the raised PM launcher.
// Where the pair lands at each width is measured in e2e/save-bar-keeps-its-button.spec.ts.
describe("SaveBar's buttons", () => {
  it("wrap as one pair, after a spacer that stays behind on the row above", () => {
    render(<SaveBar pending={[group]} total={1} onGoToSection={vi.fn()} />);

    const discard = screen.getByRole("button", { name: "Discard" });
    const save = screen.getByRole("button", { name: "Save changes" });
    const pair = discard.parentElement!;
    expect(save.parentElement).toBe(pair);
    expect(pair.children).toHaveLength(2);
    expect(pair.previousElementSibling!.className).toMatch(/\bflex-1\b/);
  });

  it("never break their own labels", () => {
    render(<SaveBar pending={[group]} total={1} onGoToSection={vi.fn()} />);

    for (const name of ["Discard", "Save changes"]) {
      expect(screen.getByRole("button", { name }).className).toMatch(/\bwhitespace-nowrap\b/);
    }
  });
});

/**
 * BP-738. A closed bar is clipped to nothing, not removed, so whatever it still holds is on the page
 * for anything reading text rather than pixels. It keeps the last summary for the slide only.
 */
describe("SaveBar once it has closed", () => {
  const summary = () => screen.queryByText(/unsaved change/)?.textContent ?? null;

  it("holds no summary on a page that never had anything to save", () => {
    render(<SaveBar pending={[]} total={0} onGoToSection={vi.fn()} />);

    expect(summary()).toBeNull();
  });

  it("keeps the last summary while it slides away, and drops it once the slide has ended", () => {
    const { container, rerender } = render(
      <SaveBar pending={[group]} total={1} onGoToSection={vi.fn()} />
    );
    rerender(<SaveBar pending={[]} total={0} onGoToSection={vi.fn()} />);

    expect(summary()).toContain("1 unsaved change");

    fireEvent.transitionEnd(container.firstElementChild!);

    expect(summary()).toBeNull();
    expect(screen.queryByRole("button", { name: "Save changes", hidden: true })).toBeNull();
  });

  it("is not emptied by a transition that ends on something inside it", () => {
    const { rerender } = render(<SaveBar pending={[group]} total={1} onGoToSection={vi.fn()} />);
    rerender(<SaveBar pending={[]} total={0} onGoToSection={vi.fn()} />);

    fireEvent.transitionEnd(screen.getByRole("button", { name: "Discard", hidden: true }));

    expect(summary()).toContain("1 unsaved change");
  });

  // A close that runs no transition fires no transitionend, and the summary must go all the same
  it("drops the summary even when no transition tells it the slide has ended", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<SaveBar pending={[group]} total={1} onGoToSection={vi.fn()} />);
      rerender(<SaveBar pending={[]} total={0} onGoToSection={vi.fn()} />);
      expect(summary()).toContain("1 unsaved change");

      act(() => {
        vi.advanceTimersByTime(400);
      });

      expect(summary()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the new summary when something is changed again after it slid away", () => {
    const { container, rerender } = render(
      <SaveBar pending={[group]} total={1} onGoToSection={vi.fn()} />
    );
    rerender(<SaveBar pending={[]} total={0} onGoToSection={vi.fn()} />);
    fireEvent.transitionEnd(container.firstElementChild!);

    rerender(<SaveBar pending={[{ ...group, count: 2 }]} total={2} onGoToSection={vi.fn()} />);

    expect(summary()).toContain("2 unsaved changes");
    expect(
      (screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled
    ).toBe(false);
  });
});
