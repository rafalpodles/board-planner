// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { useDeclareTaskPage, useOpenTask } from "./use-open-task";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});

const TASK = "/projects/TP/tasks/5";
const BOARD = "/projects/TP";

function TaskPage() {
  useDeclareTaskPage();
  return null;
}

function Opener({ href = TASK }: { href?: string }) {
  const openTask = useOpenTask();
  return (
    <button type="button" onClick={() => openTask(href)}>
      open
    </button>
  );
}

function open() {
  screen.getByRole("button", { name: "open" }).click();
}

beforeEach(() => {
  push.mockClear();
  assign.mockClear();
});

afterEach(() => cleanup());

describe("useOpenTask", () => {
  it("pushes when no task page is on screen, so the board keeps its modal", () => {
    render(<Opener />);

    open();

    expect(push).toHaveBeenCalledWith(TASK);
    expect(assign).not.toHaveBeenCalled();
  });

  it("loads the document when the task page is on screen", () => {
    render(
      <>
        <TaskPage />
        <Opener />
      </>
    );

    open();

    expect(assign).toHaveBeenCalledWith(TASK);
    expect(push).not.toHaveBeenCalled();
  });

  it("still pushes for something that is not a task", () => {
    render(
      <>
        <TaskPage />
        <Opener href={BOARD} />
      </>
    );

    open();

    expect(push).toHaveBeenCalledWith(BOARD);
    expect(assign).not.toHaveBeenCalled();
  });

  it("goes back to pushing once the task page is gone", () => {
    const { rerender } = render(
      <>
        <TaskPage />
        <Opener />
      </>
    );
    rerender(<Opener />);

    open();

    expect(push).toHaveBeenCalledWith(TASK);
    expect(assign).not.toHaveBeenCalled();
  });
});
