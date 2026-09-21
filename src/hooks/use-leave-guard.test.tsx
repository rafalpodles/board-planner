// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { mayLeave, useLeaveGuard } from "./use-leave-guard";

/**
 * The wrapper stands in for Next's `<Link>`: React's handler, delegated at the root, takes the click
 * in the bubble phase and navigates in code. A guard that listened in the bubble phase too would run
 * after it and never get to ask — which is why these assert on `navigate`, not on the event.
 */
function Page({ dirty, navigate }: { dirty: boolean; navigate: (href: string) => void }) {
  useLeaveGuard(dirty, "Leave without saving?");
  return (
    <div
      onClick={(e) => {
        const anchor = (e.target as Element).closest("a");
        if (!anchor) return;
        e.preventDefault();
        navigate(anchor.getAttribute("href") ?? "");
      }}
    >
      <a href="/agents">Agents</a>
      <a href="https://example.com/elsewhere">Elsewhere</a>
      <a href="/agents" target="_blank">New tab</a>
    </div>
  );
}

function click(text: string, init: MouseEventInit = {}) {
  const anchor = Array.from(document.querySelectorAll("a")).find((a) => a.textContent === text)!;
  fireEvent(anchor, new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init }));
}

beforeEach(() => {
  // One window serves the whole file, and a path left behind by one test can satisfy another's
  // "same page" early return — which is how the no-unsaved control once passed for that reason
  window.history.replaceState(null, "", "/agents/a1");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useLeaveGuard", () => {
  it("asks before following an in-app link, and stays when the answer is no", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const navigate = vi.fn();
    render(<Page dirty navigate={navigate} />);

    click("Agents");

    expect(confirm).toHaveBeenCalledWith("Leave without saving?");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("lets the link through when the answer is yes", () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const navigate = vi.fn();
    render(<Page dirty navigate={navigate} />);

    click("Agents");

    expect(navigate).toHaveBeenCalledWith("/agents");
  });

  // The control: a page with nothing unsaved must not ask anything, or the guard is noise
  it("asks nothing when there is nothing unsaved", () => {
    const confirm = vi.spyOn(window, "confirm");
    const navigate = vi.fn();
    render(<Page dirty={false} navigate={navigate} />);

    click("Agents");

    expect(confirm).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/agents");
  });

  it("leaves a link to another site, a new tab and a modified click alone — none loses the page", () => {
    const confirm = vi.spyOn(window, "confirm");
    render(<Page dirty navigate={vi.fn()} />);

    click("Elsewhere");
    click("New tab");
    click("Agents", { metaKey: true });

    expect(confirm).not.toHaveBeenCalled();
  });

  it("holds a reload or a closed tab with the browser's own prompt", () => {
    render(<Page dirty navigate={vi.fn()} />);
    const event = new Event("beforeunload", { cancelable: true });

    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });
});

describe("mayLeave", () => {
  it("asks while a page holds unsaved work, and answers for the caller", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<Page dirty navigate={vi.fn()} />);

    expect(mayLeave()).toBe(false);
    expect(confirm).toHaveBeenCalledWith("Leave without saving?");
  });

  it("lets code navigate freely once the page has nothing unsaved, or is gone", () => {
    const confirm = vi.spyOn(window, "confirm");
    const { rerender, unmount } = render(<Page dirty navigate={vi.fn()} />);

    rerender(<Page dirty={false} navigate={vi.fn()} />);
    expect(mayLeave()).toBe(true);

    rerender(<Page dirty navigate={vi.fn()} />);
    unmount();
    expect(mayLeave()).toBe(true);

    expect(confirm).not.toHaveBeenCalled();
  });
});
