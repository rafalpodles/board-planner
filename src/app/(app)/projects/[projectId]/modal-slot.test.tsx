// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ModalOverPage } from "./modal-slot";

const segment = vi.fn<() => string | null>();

afterEach(() => cleanup());

vi.mock("next/navigation", () => ({
  useSelectedLayoutSegment: (key?: string) => {
    if (key !== "children") throw new Error(`asked for the ${key} slot, not children`);
    return segment();
  },
}));

function renderSlot() {
  render(
    <ModalOverPage>
      <div>the modal</div>
    </ModalOverPage>
  );
}

describe("ModalOverPage", () => {
  it("draws the modal over the board", () => {
    segment.mockReturnValue("__PAGE__");
    renderSlot();
    expect(screen.queryByText("the modal")).not.toBeNull();
  });

  it("draws the modal over the other pages the project has", () => {
    for (const below of ["dashboard", "settings", "sprints", "pm", null]) {
      segment.mockReturnValue(below);
      renderSlot();
    }
    expect(screen.queryAllByText("the modal")).toHaveLength(5);
  });

  it("stays off a page that is already a task", () => {
    segment.mockReturnValue("tasks");
    renderSlot();
    expect(screen.queryByText("the modal")).toBeNull();
  });
});
