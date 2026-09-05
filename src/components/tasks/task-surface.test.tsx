// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TaskSurface, useOpenTask } from "./task-surface";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});

function Opener() {
  const openTask = useOpenTask();
  return (
    <button type="button" onClick={() => openTask("/projects/TP/tasks/5")}>
      open
    </button>
  );
}

beforeEach(() => {
  push.mockClear();
  assign.mockClear();
});

afterEach(() => cleanup());

describe("useOpenTask", () => {
  it("leaves the full page with a document load, so nothing is intercepted", () => {
    render(
      <TaskSurface value="page">
        <Opener />
      </TaskSurface>
    );

    screen.getByRole("button", { name: "open" }).click();

    expect(assign).toHaveBeenCalledWith("/projects/TP/tasks/5");
    expect(push).not.toHaveBeenCalled();
  });

  it("swaps the modal with a push, leaving the board underneath", () => {
    render(
      <TaskSurface value="modal">
        <Opener />
      </TaskSurface>
    );

    screen.getByRole("button", { name: "open" }).click();

    expect(push).toHaveBeenCalledWith("/projects/TP/tasks/5");
    expect(assign).not.toHaveBeenCalled();
  });

  it("takes the modal's route when nobody says which surface it is", () => {
    render(<Opener />);

    screen.getByRole("button", { name: "open" }).click();

    expect(push).toHaveBeenCalledWith("/projects/TP/tasks/5");
    expect(assign).not.toHaveBeenCalled();
  });
});
