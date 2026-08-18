// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, waitFor } from "@testing-library/react";
import { useTaskEditor } from "./useTaskEditor";
import { ApiTask } from "@/types";

const { api } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/lib/board-refresh", () => ({ emitBoardRefresh: vi.fn() }));

const baseTask = {
  _id: "t1",
  taskNumber: 6,
  title: "Recurring one",
  description: "",
  status: "todo",
  priority: "high",
  difficulty: "L",
  category: "idea",
  component: "",
  assignee: null,
  dueDate: null,
  labels: [],
  checklist: [],
  customFieldValues: {},
  recurrence: null,
  sprint: null,
} as unknown as ApiTask;

function Harness({ task }: { task: ApiTask }) {
  const { draft, set, autoSaveState, retry } = useTaskEditor("p1", task);
  return (
    <div>
      <input
        aria-label="title"
        value={draft.title}
        onChange={(e) => set("title", e.target.value)}
      />
      <span data-testid="state">{autoSaveState}</span>
      <span data-testid="priority">{draft.priority}</span>
      <button onClick={retry}>retry</button>
    </div>
  );
}

function titleField() {
  return screen.getByLabelText("title") as HTMLInputElement;
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
  api.put.mockReset();
  api.put.mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("useTaskEditor", () => {
  it("waits out the debounce, then sends the edited field alone", async () => {
    render(<Harness task={baseTask} />);

    await act(async () => type(titleField(), "Recurring one ZZ"));
    expect(api.put).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(700);
    });

    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("saved"));
    expect(api.put).toHaveBeenCalledWith("/api/projects/p1/tasks/t1", {
      title: "Recurring one ZZ",
    });
  });

  // The debounce cleanup also runs on unmount, so closing inside the window used
  // to drop the edit silently
  it("flushes a pending edit when the view goes away inside the debounce window", async () => {
    const { unmount } = render(<Harness task={baseTask} />);

    await act(async () => type(titleField(), "Closed too fast"));
    expect(api.put).not.toHaveBeenCalled();

    await act(async () => unmount());

    expect(api.put).toHaveBeenCalledWith("/api/projects/p1/tasks/t1", {
      title: "Closed too fast",
    });
  });

  it("sends nothing on unmount when nothing was edited", async () => {
    const { unmount } = render(<Harness task={baseTask} />);
    await act(async () => unmount());
    expect(api.put).not.toHaveBeenCalled();
  });

  it("offers a retry that goes out immediately when a save fails", async () => {
    api.put.mockRejectedValueOnce(new Error("nope"));
    render(<Harness task={baseTask} />);

    await act(async () => type(titleField(), "Recurring one QQ"));
    await act(async () => {
      vi.advanceTimersByTime(700);
    });
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("error"));

    api.put.mockResolvedValue({});
    await act(async () => screen.getByText("retry").click());

    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("saved"));
    expect(api.put).toHaveBeenCalledTimes(2);
  });

  // A PM move or a second tab must not be clobbered, but it must not win over
  // what the user is in the middle of typing either
  it("adopts a server change only for fields the user has not edited", async () => {
    const { rerender } = render(<Harness task={baseTask} />);

    await act(async () => type(titleField(), "Mine, still pending"));

    await act(async () => {
      rerender(
        <Harness task={{ ...baseTask, title: "Theirs", priority: "low" } as ApiTask} />
      );
    });

    expect(titleField().value).toBe("Mine, still pending");
    expect(screen.getByTestId("priority").textContent).toBe("low");
  });

  /**
   * The task routes populate `agent` so the reader can be told the name of an agent
   * `/api/agents` withholds. The draft holds the picker's VALUE, which is the id — seeded with the
   * document instead, the picker matches no option and the field reads as permanently edited
   * against the stored task.
   */
  it("seeds the agent from a populated reference by its id", () => {
    function AgentHarness({ task }: { task: ApiTask }) {
      const { draft } = useTaskEditor("p1", task);
      return <span data-testid="agent">{String(draft.agent)}</span>;
    }

    render(
      <AgentHarness
        task={{ ...baseTask, agent: { _id: "a9", name: "Somebody's own" } } as unknown as ApiTask}
      />
    );

    expect(screen.getByTestId("agent").textContent).toBe("a9");
  });

  // The other shape the same field arrives in: a writer echoing back what it was sent
  it("takes a bare agent id as it comes", () => {
    function AgentHarness({ task }: { task: ApiTask }) {
      const { draft } = useTaskEditor("p1", task);
      return <span data-testid="agent">{String(draft.agent)}</span>;
    }

    render(<AgentHarness task={{ ...baseTask, agent: "a9" } as unknown as ApiTask} />);

    expect(screen.getByTestId("agent").textContent).toBe("a9");
  });
});
