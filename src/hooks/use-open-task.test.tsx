// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { useDeclareTaskPage, useOpenTask } from "./use-open-task";

const push = vi.fn();
let pathname = "/projects/TP";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => pathname,
}));

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
  pathname = "/projects/TP";
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

  describe("a task on another board", () => {
    it("is a document load even from the board, so the modal cannot draw the wrong one", () => {
      pathname = "/projects/TP";
      render(<Opener href="/projects/SB/tasks/1" />);

      open();

      expect(assign).toHaveBeenCalledWith("/projects/SB/tasks/1");
      expect(push).not.toHaveBeenCalled();
    });

    it("is only another board when the two names really differ", () => {
      pathname = "/projects/tp/tasks/2";
      render(<Opener href="/projects/TP/tasks/5" />);

      open();

      expect(push).toHaveBeenCalledWith("/projects/TP/tasks/5");
      expect(assign).not.toHaveBeenCalled();
    });

    it("leaves a project page alone, wherever it belongs", () => {
      pathname = "/projects/TP";
      render(<Opener href="/projects/SB" />);

      open();

      expect(push).toHaveBeenCalledWith("/projects/SB");
      expect(assign).not.toHaveBeenCalled();
    });
  });
});
