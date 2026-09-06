// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { ShortcutHelp } from "./ShortcutHelp";

afterEach(cleanup);

describe("ShortcutHelp structure", () => {
  it("pairs each description with its key as a definition list, not an unpaired span/kbd", () => {
    render(<ShortcutHelp open onClose={() => {}} />);

    const row = screen.getByText("Search tasks and projects").closest("div")!;
    expect(row.parentElement?.tagName).toBe("DL");
    expect(screen.getByText("Search tasks and projects").tagName).toBe("DT");
    expect(row.querySelector("dd kbd")).not.toBeNull();
  });

  it("gives a glyph a visually-hidden spoken label, alongside the glyph itself", () => {
    render(<ShortcutHelp open onClose={() => {}} />);

    const kbd = screen.getByText("Search tasks and projects").closest("div")!.querySelector("kbd")!;
    expect(kbd.textContent).toContain("Cmd");
    expect(kbd.querySelector('[aria-hidden="true"]')?.textContent).toBe("⌘");
    expect(kbd.querySelector(".sr-only")?.textContent).toBe("Cmd");
  });

  it("lists only search under Anywhere; board-only shortcuts moved out", () => {
    render(<ShortcutHelp open onClose={() => {}} />);

    const anywhere = screen.getByRole("heading", { name: "Anywhere" }).closest("section")!;
    expect(within(anywhere).getByText("Search tasks and projects")).toBeTruthy();
    expect(within(anywhere).queryByText("Create new task")).toBeNull();

    // Still documented — just not under a heading that also covers card/row interactions
    const board = screen.getByRole("heading", { name: "Board" }).closest("section")!;
    expect(within(board).getByText("Create new task")).toBeTruthy();
    const cards = screen.getByRole("heading", { name: "Cards" }).closest("section")!;
    expect(within(cards).queryByText("Create new task")).toBeNull();
  });
});

describe("ShortcutHelp, conditional rows", () => {
  it("offers both N and V on a normal, unlocked board", () => {
    render(<ShortcutHelp open onClose={() => {}} />);
    expect(screen.getByText("Create new task")).toBeTruthy();
    expect(screen.getByText("Toggle view: board", { exact: false })).toBeTruthy();
  });

  it("hides N when readOnly, and still offers V", () => {
    render(<ShortcutHelp open onClose={() => {}} readOnly />);
    expect(screen.queryByText("Create new task")).toBeNull();
    expect(screen.getByText("Toggle view: board", { exact: false })).toBeTruthy();
  });

  it("hides V when pinViewMode is set, and still offers N", () => {
    render(<ShortcutHelp open onClose={() => {}} pinViewMode="board" />);
    expect(screen.getByText("Create new task")).toBeTruthy();
    expect(screen.queryByText("Toggle view: board", { exact: false })).toBeNull();
  });

  it("hides both at once, without taking the Board section's other rows down with them", () => {
    render(<ShortcutHelp open onClose={() => {}} readOnly pinViewMode="board" />);
    expect(screen.queryByText("Create new task")).toBeNull();
    expect(screen.queryByText("Toggle view: board", { exact: false })).toBeNull();
    expect(screen.getByText("Refresh board")).toBeTruthy();
  });
});
