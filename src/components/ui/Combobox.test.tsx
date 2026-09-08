// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Combobox } from "./Combobox";

const observers: (() => void)[] = [];
const observed: Element[] = [];
vi.stubGlobal(
  "ResizeObserver",
  class {
    constructor(cb: () => void) {
      observers.push(cb);
    }
    observe(target: Element) {
      observed.push(target);
    }
    disconnect() {}
  }
);

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

function pinnedBar(box: { top: number; bottom: number }, attribute = "data-pinned-bottom-bar") {
  const bar = document.createElement("div");
  bar.setAttribute(attribute, "");
  document.body.append(bar);
  stateRect(bar, box);
  return bar;
}

/** Fires every ResizeObserver this render created; happy-dom has none of its own */
const resized = () => observers.forEach((cb) => cb());

function open(trigger: { top: number; bottom: number; left?: number }) {
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
  observers.length = 0;
  observed.length = 0;
  document.querySelectorAll("[data-pinned-phone-bar]").forEach((el) => el.remove());
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
    // Without the cap the panel's 260px would put its top at -150. With it, the top lands on the
    // margin the constant names — 12, not merely "somewhere on the screen"
    const top = 260 - Number.parseInt(panel.style.bottom) - Number.parseInt(panel.style.maxHeight);
    expect(top).toBe(12);
    expect(panel.style.maxHeight).toBe("102px");
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

  // The arrangement the real screen has, and the one the two tests above cannot reach: the
  // settings column scrolls *under* its save bar, so the trigger is behind the bar rather than
  // above it. Flipping above such a trigger still lands on the bar
  it("hangs off the bar when the trigger itself is behind one", () => {
    stateViewport(720);
    pinnedBar({ top: 614, bottom: 696 });
    const panel = open({ top: 682, bottom: 720 });

    expect(panel.style.bottom).toBe(`${720 - 614 + 4}px`);
    expect(720 - Number.parseInt(panel.style.bottom)).toBeLessThanOrEqual(614);
  });

  // The phone bar is the same fact under a different attribute. Read at the wrong breakpoint it
  // was excluded while on screen, so what counts is that it has a height, not how wide the window is
  it("counts a phone bar the same way", () => {
    stateViewport(844, 390);
    // 68px, which is what the comment bar measures — a taller one would make the arithmetic work
    // for a bar this product does not have
    pinnedBar({ top: 776, bottom: 844 }, "data-pinned-phone-bar");
    // Against the viewport there is room below for the whole panel; against the free space there
    // is not, so counting the bar is the difference between hanging down and flipping
    const panel = open({ top: 600, bottom: 640 });

    expect(panel.style.top).toBe("");
    expect(panel.style.bottom).toBe(`${844 - 600 + 4}px`);
  });

  it("re-places when a bar arrives after the panel is open", async () => {
    stateViewport(720);
    const panel = open({ top: 400, bottom: 440 });
    expect(panel.style.top).toBe("444px");

    const late = document.createElement("div");
    stateRect(late, { top: 500, bottom: 700 });
    document.body.append(late);
    await act(async () => {
      late.setAttribute("data-pinned-bottom-bar", "");
      await Promise.resolve();
    });

    // Only 56px are left below it now, so the panel that was hanging down goes above instead
    const placed = document.querySelector('[role="listbox"]')!.parentElement as HTMLElement;
    expect(placed.style.top).toBe("");
    expect(placed.style.bottom).toBe(`${720 - 400 + 4}px`);
  });

  // The old rule asked only whether the trigger had more room above it than the panel wanted
  // below; it flipped into a space smaller than the one it left
  it("stays below when there is less room above than below", () => {
    stateViewport(720);
    pinnedBar({ top: 660, bottom: 720 });
    // below = 660 - 450 - 4 = 206, above = 210 - 12 = 198
    const panel = open({ top: 210, bottom: 450 });

    expect(panel.style.top).toBe("454px");
    expect(panel.style.maxHeight).toBe("206px");
  });

  it("keeps the panel inside the right-hand edge", () => {
    stateViewport(720, 400);
    const panel = open({ top: 100, bottom: 140, left: 320 });

    // 400 - 224 - 8
    expect(panel.style.left).toBe("168px");
  });

  it("re-places when the trigger grows under it", () => {
    stateViewport(720);
    const panel = open({ top: 100, bottom: 140 });
    expect(panel.style.top).toBe("144px");

    const trigger = screen.getByRole("combobox", { name: "Template category" });
    stateRect(trigger, { top: 100, bottom: 180 });
    act(() => {
      resized();
    });

    expect(
      (document.querySelector('[role="listbox"]')!.parentElement as HTMLElement).style.top
    ).toBe("184px");
  });

  // A bar hidden at this width is `display: none`, so it has no rectangle. That is the whole
  // reason the breakpoint query could be deleted, and it was the untested half of it
  it("ignores a bar that is not on screen", () => {
    stateViewport(720);
    pinnedBar({ top: 0, bottom: 0 }, "data-pinned-phone-bar");
    const panel = open({ top: 100, bottom: 140 });

    // A zero-height bar read as a floor would put the panel above the trigger, or nowhere
    expect(panel.style.top).toBe("144px");
    expect(panel.style.maxHeight).toBe("260px");
  });

  it("observes the trigger and every bar, not just its own panel", () => {
    stateViewport(720);
    const bar = pinnedBar({ top: 630, bottom: 700 });
    open({ top: 100, bottom: 140 });

    expect(observed).toContain(screen.getByRole("combobox", { name: "Template category" }));
    expect(observed).toContain(bar);
  });

  it("re-places when a phone bar arrives after the panel is open", async () => {
    stateViewport(844, 390);
    // Low enough that the 68px bar is what tips it, high enough that it hangs down until then
    const panel = open({ top: 500, bottom: 540 });
    expect(panel.style.top).toBe("544px");

    const late = document.createElement("div");
    stateRect(late, { top: 776, bottom: 844 });
    document.body.append(late);
    await act(async () => {
      late.setAttribute("data-pinned-phone-bar", "");
      await Promise.resolve();
    });

    const placed = document.querySelector('[role="listbox"]')!.parentElement as HTMLElement;
    expect(placed.style.top).toBe("");
    expect(placed.style.bottom).toBe(`${844 - 500 + 4}px`);
  });

  // Focus belongs to the reader once the panel is open: a re-measure produces a fresh placement
  // object every time, and having that in the focus effect's deps took focus off the option they
  // had just clicked
  it("leaves focus where the reader put it when the panel is re-placed", () => {
    stateViewport(720);
    open({ top: 100, bottom: 140 });

    const option = screen.getByRole("option", { name: "Beta" });
    act(() => option.focus());
    expect(document.activeElement).toBe(option);

    act(() => {
      resized();
    });

    expect(document.activeElement).toBe(option);
  });

  // happy-dom lays nothing out, so this asserts the mechanism rather than the result: the panel is
  // a column and the list is the part that gives. The heights themselves were measured in a real
  // browser, at three panel caps with a search box present
  it("lets the list, and only the list, take what is left of the panel", () => {
    stateViewport(720);
    const panel = open({ top: 100, bottom: 140 });
    const listbox = panel.querySelector('[role="listbox"]')!;

    expect(panel.className).toContain("flex-col");
    expect(listbox.className).toContain("flex-1");
    expect(listbox.className).toContain("min-h-0");
    expect(listbox.className).toContain("overflow-y-auto");
  });
});

/**
 * BP-547 item 2. With eight or more options the panel grows a search box and focuses it, and from
 * that point the arrows move a highlight in a list the focused element said nothing about. Nothing
 * in the suite typed into that box before, which is why it and the missing focus indicator were
 * both invisible.
 */
describe("the search box the panel grows", () => {
  const MANY = Array.from({ length: 9 }, (_, i) => ({
    value: `v${i}`,
    label: `Option ${i}`,
  }));

  function openWithSearch() {
    render(
      <Combobox options={MANY} label="Assignee" onChange={() => {}} value="v0">
        {(picked) => <span>{picked?.label ?? "None"}</span>}
      </Combobox>
    );
    const button = screen.getByRole("combobox", { name: "Assignee" });
    stateRect(button, { top: 100, bottom: 140 });
    fireEvent.click(button);
    return screen.getByRole("combobox", { name: "Search Assignee" });
  }

  it("leaves the listbox's own activedescendant off, since nothing is focused there", () => {
    stateViewport(900);
    openWithSearch();

    expect(
      document.querySelector('[role="listbox"]')!.getAttribute("aria-activedescendant")
    ).toBeNull();
  });

  // The positive twin, because `!showSearch` is a guard with two sides: without this, inverting it
  // would take the attribute off the branch BP-532 put it on and only the e2e would notice
  it("keeps it on the listbox when there is no search box, which is what BP-532 fixed", () => {
    stateViewport(900);
    open({ top: 100, bottom: 140 });

    const listbox = document.querySelector('[role="listbox"]')!;
    const named = listbox.getAttribute("aria-activedescendant");
    expect(named).not.toBeNull();
    expect(document.getElementById(named!)?.textContent).toContain("Alpha");
  });

  it("is the combobox itself, pointing at the list the arrows move through", () => {
    stateViewport(900);
    const box = openWithSearch();
    const listbox = document.querySelector('[role="listbox"]')!;

    expect(document.activeElement).toBe(box);
    expect(box.getAttribute("aria-controls")).toBe(listbox.id);
    expect(box.getAttribute("aria-expanded")).toBe("true");
  });

  it("names the option the highlight is on, and follows it", () => {
    stateViewport(900);
    const box = openWithSearch();

    const first = box.getAttribute("aria-activedescendant");
    expect(document.getElementById(first!)?.textContent).toContain("Option 0");

    fireEvent.keyDown(box, { key: "ArrowDown" });

    const second = box.getAttribute("aria-activedescendant");
    expect(second).not.toBe(first);
    expect(document.getElementById(second!)?.textContent).toContain("Option 1");
  });

  it("points at the first match after typing, not at a stale row", () => {
    stateViewport(900);
    const box = openWithSearch();

    // Moved first, deliberately: typing without it leaves `active` at 0, where "reset to the top"
    // and "leave it where it was" agree — the assertion would hold either way
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.change(box, { target: { value: "Option 7" } });

    const current = box.getAttribute("aria-activedescendant");
    expect(document.getElementById(current!)?.textContent).toContain("Option 7");
  });

  it("names nothing when nothing matches", () => {
    stateViewport(900);
    const box = openWithSearch();

    fireEvent.change(box, { target: { value: "no such option" } });

    expect(box.getAttribute("aria-activedescendant")).toBeNull();
    expect(screen.getByText("No matches")).toBeTruthy();
  });

  // The panel is `overflow-hidden`, so an offset outline is cropped: the inset variant is the one
  // that shows. A bare `outline-none` — what this was — escapes `focus-treatment.test.ts`, which
  // matches `focus:outline-none`
  it("has a focus indicator that the panel cannot crop", () => {
    stateViewport(900);
    const classes = openWithSearch().getAttribute("class")!.split(/\s+/);

    expect(classes).toContain("focus-ring-inset");
    expect(classes).not.toContain("outline-none");
  });
});
