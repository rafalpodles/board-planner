// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { CopyTaskLink } from "./CopyTaskLink";

function renderButton() {
  render(<CopyTaskLink projectRef="TP" taskNumber={7} taskKey="TP-7" />);
  return screen.getByRole("button", { name: "Copy link to TP-7" });
}

async function click(el: Element) {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  await act(async () => {
    el.dispatchEvent(event);
  });
  return event;
}

async function press(el: Element, key: string) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  await act(async () => {
    el.dispatchEvent(event);
  });
  return event;
}

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("CopyTaskLink", () => {
  it("copies the task's absolute URL, not just its key", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    await click(renderButton());
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/projects/TP/tasks/7`);
  });

  it("confirms the copy and goes quiet again after two seconds", async () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined));
    const button = renderButton();
    await click(button);
    expect(button.getAttribute("title")).toBe("Copied!");
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(button.getAttribute("title")).toBe("Copy link to TP-7");
  });

  // A browser can refuse the clipboard outright (insecure context, denied permission);
  // silence would read as a successful copy the user then pastes nothing from
  it("says so when the browser refuses the clipboard", async () => {
    stubClipboard(vi.fn().mockRejectedValue(new Error("denied")));
    const button = renderButton();
    await click(button);
    expect(button.getAttribute("title")).toBe("Copy failed");
  });

  it("survives a browser with no clipboard API at all", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    const button = renderButton();
    await click(button);
    expect(button.getAttribute("title")).toBe("Copy failed");
  });

  // The button sits inside a card and a row that both open the task on click
  it("does not let the click reach the card or row underneath", async () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined));
    const outer = vi.fn();
    document.body.addEventListener("click", outer);
    const event = await click(renderButton());
    document.body.removeEventListener("click", outer);
    expect(outer).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  // The board's Enter handler listens on the node React delegates from, which a
  // synthetic stopPropagation never reaches
  it("keeps Enter away from the board's own handler", async () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined));
    const button = renderButton();
    const boardHandler = vi.fn();
    document.addEventListener("keydown", boardHandler);
    await press(button, "Enter");
    document.removeEventListener("keydown", boardHandler);
    expect(boardHandler).not.toHaveBeenCalled();
  });

  it("leaves other keys alone", async () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined));
    const button = renderButton();
    const boardHandler = vi.fn();
    document.addEventListener("keydown", boardHandler);
    await press(button, "j");
    document.removeEventListener("keydown", boardHandler);
    expect(boardHandler).toHaveBeenCalledTimes(1);
  });
});
