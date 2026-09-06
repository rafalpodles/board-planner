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

  it("takes both halves from the address, not the params of the board being left", () => {
    pathname = "/projects/SB/tasks/1";
    render(<TaskDetailModal />);
    expect(screen.queryByText("asked for SB/1")).not.toBeNull();
    expect(screen.queryByText("asked for TP/1")).toBeNull();
  });

  it("falls back to the params when the address is not a task's", () => {
    pathname = "/projects/TP";
    render(<TaskDetailModal />);
    expect(screen.queryByText("asked for TP/9")).not.toBeNull();
  });
});
