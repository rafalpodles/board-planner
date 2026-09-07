// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import TaskDetailModal from "./page";

const params = { projectId: "TP", taskId: "9" };
let pathname = "/projects/TP/tasks/9";

vi.mock("next/navigation", () => ({
  useParams: () => params,
  usePathname: () => pathname,
  useRouter: () => ({ back: vi.fn() }),
}));

vi.mock("@/components/ui/Modal", () => ({
  Modal: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/tasks/TaskDetail", () => ({
  TaskDetail: ({ projectId, taskId }: { projectId: string; taskId: string }) => (
    <p>{`asked for ${projectId}/${taskId}`}</p>
  ),
}));

afterEach(() => cleanup());

describe("the intercepting task modal", () => {
  it("asks for the task the address names", () => {
    pathname = "/projects/TP/tasks/9";
    render(<TaskDetailModal />);
    expect(screen.queryByText("asked for TP/9")).not.toBeNull();
  });

  /**
   * The params belong to the layout the modal was intercepted into, which is the board being left.
   * Taking the project from there and the task from the URL named two different tasks (BP-540).
   */
  it("takes both halves from the address, not the params of the board being left", () => {
    pathname = "/projects/SB/tasks/1";
    render(<TaskDetailModal />);
    expect(screen.queryByText("asked for SB/1")).not.toBeNull();
    expect(screen.queryByText("asked for TP/1")).toBeNull();
  });

  /**
   * BP-541. This used to fall back to the params and draw the board's own task — which is the bug:
   * an unmatched parallel slot keeps its active subpage across a soft navigation, so leaving the
   * task for a project page left the modal parked over the board that arrived.
   */
  it("draws nothing once the address stops naming a task", () => {
    pathname = "/projects/TP";
    render(<TaskDetailModal />);
    expect(screen.queryByText(/asked for/)).toBeNull();
  });

  it("still draws while the address names one", () => {
    pathname = "/projects/TP/tasks/9";
    render(<TaskDetailModal />);
    expect(screen.queryByText("asked for TP/9")).not.toBeNull();
  });
});
