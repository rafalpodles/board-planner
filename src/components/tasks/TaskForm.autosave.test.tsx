// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, waitFor } from "@testing-library/react";
import { TaskForm } from "./TaskForm";
import { ApiTask } from "@/types";

const { api } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), upload: vi.fn() },
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/board-refresh", () => ({ emitBoardRefresh: vi.fn() }));
vi.mock("@/components/ui/MarkdownEditor", () => ({
  MarkdownEditor: ({ value }: { value: string }) => <div data-testid="md">{value}</div>,
}));

const task = {
  _id: "t1",
  taskNumber: 6,
  title: "Recurring one",
  description: "",
  status: "todo",
  priority: "high",
  difficulty: "L",
  category: "idea",
  component: "",
  labels: [],
  checklist: [],
  customFieldValues: {},
} as unknown as ApiTask;

function renderForm() {
  return render(
    <TaskForm
      projectId="p1"
      task={task}
      components={[]}
      categories={["idea"]}
      onSaved={() => {}}
      onCancel={() => {}}
    />
  );
}

function titleField() {
  return screen.getByDisplayValue("Recurring one") as HTMLInputElement;
}

function type(field: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  )!.set!;
  setter.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  api.get.mockReset();
  api.put.mockReset();
  api.get.mockResolvedValue([]);
  api.put.mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("TaskForm autosave", () => {
  it("offers no manual save button for an existing task", async () => {
    renderForm();
    await waitFor(() => expect(titleField()).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Update Task/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });

  it("says it saves by itself before anything is edited", async () => {
    renderForm();
    await waitFor(() => expect(titleField()).toBeTruthy());
    expect(screen.getByText("Saves automatically")).toBeTruthy();
  });

  it("reports saving and then saved as an edit goes out", async () => {
    renderForm();
    await waitFor(() => expect(titleField()).toBeTruthy());

    await act(async () => type(titleField(), "Recurring one ZZ"));
    expect(api.put).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(700);
    });
    await waitFor(() => expect(screen.getByText("✓ Saved")).toBeTruthy());
    expect(api.put).toHaveBeenCalledWith("/api/projects/p1/tasks/t1", {
      title: "Recurring one ZZ",
    });
  });

  // Without the button there is no second chance, and the debounce cleanup also
  // runs on unmount — so closing inside the window used to drop the edit silently
  it("flushes a pending edit when the form goes away inside the debounce window", async () => {
    const { unmount } = renderForm();
    await waitFor(() => expect(titleField()).toBeTruthy());

    await act(async () => type(titleField(), "Closed too fast"));
    expect(api.put).not.toHaveBeenCalled();

    await act(async () => unmount());

    expect(api.put).toHaveBeenCalledWith("/api/projects/p1/tasks/t1", {
      title: "Closed too fast",
    });
  });

  it("sends nothing on unmount when nothing was edited", async () => {
    const { unmount } = renderForm();
    await waitFor(() => expect(titleField()).toBeTruthy());

    await act(async () => unmount());
    expect(api.put).not.toHaveBeenCalled();
  });

  it("offers a retry that goes out immediately when a save fails", async () => {
    api.put.mockRejectedValueOnce(new Error("nope"));
    renderForm();
    await waitFor(() => expect(titleField()).toBeTruthy());

    await act(async () => type(titleField(), "Recurring one QQ"));
    await act(async () => {
      vi.advanceTimersByTime(700);
    });

    const retry = await screen.findByRole("button", { name: /Save failed/ });
    api.put.mockResolvedValue({});
    await act(async () => retry.click());

    await waitFor(() => expect(screen.getByText("✓ Saved")).toBeTruthy());
    expect(api.put).toHaveBeenCalledTimes(2);
  });
});
