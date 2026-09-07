// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Combobox } from "./Combobox";

/**
 * BP-555 and the placement half of BP-547. happy-dom lays nothing out, so every rectangle here is
 * stated: the trigger's, and the pinned bar's. What is under test is the arithmetic that turns
 * those into a panel position, which is what went wrong — the panel was measured against the
 * viewport while the bottom of the column belonged to the save bar.
 */

const OPTIONS = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
];

function stateViewport(height: number, width = 1280) {
  vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(height);
  vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(width);
  window.matchMedia = ((query: string) => ({
    matches: /max-width: 1023px/.test(query) && width < 1024,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
}

/** Rectangles are per element, so the trigger and the bar can disagree */
function stateRect(el: Element, box: { top: number; bottom: number; left?: number }) {
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    top: box.top,
    bottom: box.bottom,
    left: box.left ?? 100,
    right: (box.left ?? 100) + 200,
    width: 200,
    height: box.bottom - box.top,
    x: box.left ?? 100,
    y: box.top,
    toJSON: () => ({}),
  } as DOMRect);
}

function pinnedBar(box: { top: number; bottom: number }) {
  const bar = document.createElement("div");
  bar.setAttribute("data-pinned-bottom-bar", "");
  document.body.append(bar);
  stateRect(bar, box);
  return bar;
}

function open(trigger: { top: number; bottom: number }) {
  render(
    <Combobox options={OPTIONS} label="Template category" onChange={() => {}} value="a">
      {(picked) => <span>{picked?.label ?? "None"}</span>}
    </Combobox>
  );
  const button = screen.getByRole("combobox", { name: "Template category" });
  stateRect(button, trigger);
  fireEvent.click(button);
  return document.querySelector<HTMLElement>('[role="listbox"]')!.parentElement!;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.querySelectorAll("[data-pinned-bottom-bar]").forEach((el) => el.remove());
});

describe("where the panel lands", () => {
  it("keeps clear of a bar pinned to the bottom", () => {
    stateViewport(720);
    pinnedBar({ top: 630, bottom: 676 });
    // Against the viewport there is room below (720 - 440 = 280) and the panel hangs down into
    // the bar. Against the free space there is not (630 - 440 = 190), so it goes above instead
    const panel = open({ top: 400, bottom: 440 });

    expect(panel.style.top).toBe("");
    expect(panel.style.bottom).toBe(`${720 - 400 + 4}px`);
    const bottomEdge = 720 - Number.parseInt(panel.style.bottom);
    expect(bottomEdge, "the panel ends above the bar").toBeLessThanOrEqual(630);
  });

  it("hangs below the trigger when the free space allows it, bar or no bar", () => {
    stateViewport(720);
    pinnedBar({ top: 630, bottom: 676 });
    const panel = open({ top: 100, bottom: 140 });

    expect(panel.style.top).toBe("144px");
    expect(panel.style.bottom).toBe("");
    // 630 - 140 - 4 = 486, capped at the panel's own maximum
    expect(panel.style.maxHeight).toBe("260px");
  });

  it("never runs off the top of a short window", () => {
    stateViewport(260);
    const panel = open({ top: 118, bottom: 158 });

    expect(panel.style.bottom).toBe(`${260 - 118 + 4}px`);
    // 118 - 8 above; without the cap the panel's 260px would put its top at -150
    expect(panel.style.maxHeight).toBe("110px");
    expect(260 - Number.parseInt(panel.style.bottom) - Number.parseInt(panel.style.maxHeight))
      .toBeGreaterThanOrEqual(0);
  });

  it("a resize re-places the panel instead of closing it", () => {
    stateViewport(720);
    const panel = open({ top: 100, bottom: 140 });
    expect(panel.style.top).toBe("144px");

    stateViewport(400);
    stateRect(screen.getByRole("combobox", { name: "Template category" }), {
      top: 300,
      bottom: 340,
    });
    fireEvent(window, new Event("resize"));

    expect(document.querySelector('[role="listbox"]'), "the picker stays open").not.toBeNull();
    expect(document.querySelector('[role="listbox"]')!.parentElement!.style.bottom).toBe(
      `${400 - 300 + 4}px`
    );
  });
});
