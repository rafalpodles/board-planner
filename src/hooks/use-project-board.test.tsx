// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useProjectBoard } from "@/hooks/use-project-board";

/**
 * BP-561 and BP-558, two ways the board can end up showing something the server never held.
 *
 * BP-561: the board polls every ten seconds, so a read is often in flight when somebody drags a
 * card. That read knows nothing about the drag, and applying its answer puts the old order back
 * while the server keeps the new one. BP-551 fixed the same shape in the sidebar.
 *
 * BP-558: since BP-489 a write guards on the status it read, so the loser of two overlapping
 * moves is answered with the task as it now really is. Painting the *request* instead of the
 * response showed a status nobody had written.
 */

const { api, toast } = vi.hoisted(() => ({
  api: { get: vi.fn(), put: vi.fn(), patch: vi.fn(), post: vi.fn(), del: vi.fn() },
  toast: vi.fn(),
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));
// The real one reads on mount and then on an interval. Kept honest about the first read — it is
// what puts the board on screen — and silent afterwards, so the tests fire each further read
// themselves rather than racing a timer
vi.mock("@/hooks/use-poll-while-visible", async () => {
  const { useEffect } = await import("react");
  return {
    usePollWhileVisible: (callback: () => void) => {
      useEffect(() => {
        callback();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
    },
  };
});
vi.mock("@/lib/board-refresh", () => ({ subscribeBoardRefresh: () => () => {} }));

const PROJECT = { _id: "p1", key: "BP", name: "Board", columns: [], categories: [] };
const task = (id: string, order: number, status = "todo") => ({
  _id: id,
  taskNumber: Number(id.slice(1)),
  title: id,
  status,
  order,
  project: "p1",
});

/** Resolves when the test says so, which is how a read is held in flight */
function held<T>(): { promise: Promise<T>; release: (value: T) => void } {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

let board: ReturnType<typeof useProjectBoard>;

function Probe() {
  board = useProjectBoard("p1", "all");
  return <span data-testid="order">{board.tasks.map((t) => `${t._id}:${t.order}`).join(",")}</span>;
}

function orderOnScreen() {
  return screen.getByTestId("order").textContent;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockImplementation((path: string) => {
    if (path.endsWith("/tasks")) return Promise.resolve([task("t1", 0), task("t2", 1)]);
    if (path.endsWith("/sprints")) return Promise.resolve([]);
    return Promise.resolve(PROJECT);
  });
  api.put.mockResolvedValue({});
});
afterEach(cleanup);

async function mounted() {
  render(<Probe />);
  await waitFor(() => expect(orderOnScreen()).toBe("t1:0,t2:1"));
}

describe("a read already in flight when a write starts", () => {
  it("does not put a reorder back the way it was", async () => {
    await mounted();

    // A poll goes out, and is still on the wire when the drop lands
    const poll = held<unknown>();
    api.get.mockImplementation((path: string) => {
      if (path.endsWith("/tasks")) return poll.promise;
      if (path.endsWith("/sprints")) return Promise.resolve([]);
      return Promise.resolve(PROJECT);
    });
    let reading!: Promise<void>;
    act(() => {
      reading = board.reload();
    });

    await act(async () => {
      await board.handleReorder(["t2", "t1"]);
    });
    expect(orderOnScreen()).toBe("t1:1,t2:0");

    // The read answers with what the server held before the drop
    await act(async () => {
      poll.release([task("t1", 0), task("t2", 1)]);
      await reading;
    });

    expect(orderOnScreen(), "the drop stands").toBe("t1:1,t2:0");
  });

  // The control: a read that overtook nothing is the board's only source of other people's work
  it("still applies a read that no write overtook", async () => {
    await mounted();

    api.get.mockImplementation((path: string) => {
      if (path.endsWith("/tasks")) return Promise.resolve([task("t1", 5), task("t2", 6)]);
      if (path.endsWith("/sprints")) return Promise.resolve([]);
      return Promise.resolve(PROJECT);
    });

    await act(async () => {
      await board.reload();
    });

    expect(orderOnScreen()).toBe("t1:5,t2:6");
  });
});

describe("what a status write paints", () => {
  it("shows what the server holds, not what was asked for", async () => {
    await mounted();
    // Somebody else's move won the race; the loser is told the truth
    api.patch.mockResolvedValue({ ...task("t1", 0, "shipped") });

    await act(async () => {
      await board.handleStatusChange("t1", "blocked");
    });

    expect(board.tasks.find((t) => t._id === "t1")!.status).toBe("shipped");
  });

  it("falls back to the requested status when the write answers with nothing", async () => {
    await mounted();
    api.patch.mockResolvedValue(undefined);

    await act(async () => {
      await board.handleStatusChange("t1", "blocked");
    });

    expect(board.tasks.find((t) => t._id === "t1")!.status).toBe("blocked");
  });
});
