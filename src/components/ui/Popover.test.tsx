// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { Popover } from "./Popover";

afterEach(cleanup);

function renderPopover() {
  return render(
    <Popover
      label="Status"
      trigger={({ toggle }) => (
        <button type="button" onClick={toggle}>
          open
        </button>
      )}
    >
      {({ close }) => (
        <button type="button" onClick={close}>
          pick
        </button>
      )}
    </Popover>
  );
}

async function open() {
  await act(async () => screen.getByText("open").click());
}

function mouseDownOn(target: Node) {
  act(() => {
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
}

function pressEscape() {
  const from = screen.queryByText("pick") ?? screen.getByText("open");
  act(() => {
    from.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
}

describe("Popover", () => {
  it("shows its panel only once the trigger is used", async () => {
    renderPopover();
    expect(screen.queryByText("pick")).toBeNull();
    await open();
    expect(screen.getByText("pick")).toBeTruthy();
  });

  it("closes on a click outside", async () => {
    renderPopover();
    await open();
    mouseDownOn(document.body);
    expect(screen.queryByText("pick")).toBeNull();
  });

  it("stays put for a click on its own panel", async () => {
    renderPopover();
    await open();
    mouseDownOn(screen.getByText("pick"));
    expect(screen.getByText("pick")).toBeTruthy();
  });

  it("closes on Escape", async () => {
    renderPopover();
    await open();
    pressEscape();
    expect(screen.queryByText("pick")).toBeNull();
  });

  it("keeps Escape from reaching a dialog's own document listener", async () => {
    const dialogEscape = vi.fn();
    document.addEventListener("keydown", dialogEscape);
    try {
      renderPopover();
      await open();
      pressEscape();

      expect(screen.queryByText("pick")).toBeNull();
      expect(dialogEscape).not.toHaveBeenCalled();

      pressEscape();
      expect(dialogEscape).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener("keydown", dialogEscape);
    }
  });

  it("hands close to its content", async () => {
    renderPopover();
    await open();
    await act(async () => screen.getByText("pick").click());
    expect(screen.queryByText("pick")).toBeNull();
  });
});
