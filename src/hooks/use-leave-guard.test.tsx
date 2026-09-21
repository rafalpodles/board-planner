// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { useLeaveGuard } from "./use-leave-guard";

function Page({ dirty }: { dirty: boolean }) {
  useLeaveGuard(dirty, "Leave without saving?");
  return (
    <div>
      <a href="/agents">Agents</a>
      <a href="https://example.com/elsewhere">Elsewhere</a>
      <a href="/agents" target="_blank">New tab</a>
    </div>
  );
}

function click(text: string, init: MouseEventInit = {}) {
  const anchor = Array.from(document.querySelectorAll("a")).find((a) => a.textContent === text)!;
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  fireEvent(anchor, event);
  return event;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useLeaveGuard", () => {
  it("asks before following an in-app link, and stays when the answer is no", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<Page dirty />);

    const event = click("Agents");

    expect(confirm).toHaveBeenCalledWith("Leave without saving?");
    expect(event.defaultPrevented).toBe(true);
  });

  it("lets the link through when the answer is yes", () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Page dirty />);

    expect(click("Agents").defaultPrevented).toBe(false);
  });

  // The control: a page with nothing unsaved must not ask anything, or the guard is noise
  it("asks nothing when there is nothing unsaved", () => {
    const confirm = vi.spyOn(window, "confirm");
    render(<Page dirty={false} />);

    click("Agents");

    expect(confirm).not.toHaveBeenCalled();
  });

  it("leaves a link to another site and a new tab alone — neither loses the page", () => {
    const confirm = vi.spyOn(window, "confirm");
    render(<Page dirty />);

    click("Elsewhere");
    click("New tab");
    click("Agents", { metaKey: true });

    expect(confirm).not.toHaveBeenCalled();
  });

  it("holds a reload or a closed tab with the browser's own prompt", () => {
    render(<Page dirty />);
    const event = new Event("beforeunload", { cancelable: true });

    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });
});
