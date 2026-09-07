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

let probeScope = "all";

function Probe() {
  board = useProjectBoard("p1", probeScope);
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

/** The board filtered to one sprint, which is where an optimistic move is visible */
async function mountedScoped(sprint: string) {
  probeScope = sprint;
  api.get.mockImplementation((path: string) => {
    if (path.includes("/tasks")) return Promise.resolve([task("t1", 0), task("t2", 1)]);
    if (path.endsWith("/sprints")) return Promise.resolve([{ _id: sprint, name: "Sprint one" }]);
    return Promise.resolve(PROJECT);
  });
  render(<Probe />);
  await waitFor(() => expect(orderOnScreen()).toBe("t1:0,t2:1"));
}

async function mounted() {
  probeScope = "all";
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

  // A read issued *while* the write is on the wire is as blind to it as one issued before, and
  // it was the half the first fix left open
  it("does not put a reorder back when the read started during the write", async () => {
    await mounted();

    const write = held<unknown>();
    api.put.mockImplementation(() => write.promise);
    let writing!: Promise<void>;
    act(() => {
      writing = board.handleReorder(["t2", "t1"]);
    });

    // The poll goes out now, with the write still on the wire, and is answered with what the
    // server held before it committed
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
      write.release({});
      await writing;
    });
    await act(async () => {
      poll.release([task("t1", 0), task("t2", 1)]);
      await reading;
    });

    expect(orderOnScreen(), "the drop stands").toBe("t1:1,t2:0");
  });

  it("does not undo an assignee set while a read was in flight", async () => {
    await mounted();

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

    api.put.mockResolvedValue({ _id: "t1", assignee: { _id: "u1", username: "rafal" } });
    await act(async () => {
      await board.handleAssigneeChange("t1", "rafal");
    });

    await act(async () => {
      poll.release([task("t1", 0), task("t2", 1)]);
      await reading;
    });

    expect(
      (board.tasks.find((t) => t._id === "t1")!.assignee as { username: string } | null)?.username
    ).toBe("rafal");
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

  it("keeps what only the board knows about the row", async () => {
    await mounted();
    // What a write answers with is not what the list answers with: `changeStatus` populates fewer
    // paths, and `relatedFrom` is computed on the client and never sent at all
    api.patch.mockResolvedValue({ _id: "t1", status: "shipped" });

    await act(async () => {
      await board.handleStatusChange("t1", "blocked");
    });

    const row = board.tasks.find((t) => t._id === "t1")!;
    expect(row.status).toBe("shipped");
    expect(row.title, "the row keeps the fields the answer did not mention").toBe("t1");
  });
});

/**
 * BP-588. The board's "do it anyway" confirmations closed themselves on the click and let the write
 * run behind an empty board — no busy state, and a failure toast arriving over nothing. They were
 * also never given `loading`, so there was no busy state to lose in the first place.
 */
describe("a force that is still running", () => {
  it("keeps the move's dialog open and says it is working", async () => {
    await mounted();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    let forcing!: Promise<void>;
    // Parked the way a 409 does it, rather than by writing to the returned object
    api.patch.mockRejectedValueOnce({
      status: 409,
      body: { runConflict: { workerName: "mac", phase: "agent" } },
    });
    await act(async () => {
      await board.handleStatusChange("t1", "blocked");
    });
    expect(board.heldMove, "the refusal parked it").not.toBeNull();

    api.patch.mockReturnValueOnce(held);
    act(() => {
      forcing = board.forceHeldMove();
    });

    expect(board.forcing, "the dialog can say it is working").toBe(true);
    expect(board.heldMove, "and it is still on screen").not.toBeNull();

    await act(async () => {
      release();
      await forcing;
    });

    expect(board.forcing).toBe(false);
    expect(board.heldMove, "and goes when there is an answer").toBeNull();
  });

  it("lets go of the flag even when the write fails", async () => {
    await mounted();
    api.patch.mockRejectedValueOnce({
      status: 409,
      body: { runConflict: { workerName: "mac", phase: "agent" } },
    });
    await act(async () => {
      await board.handleStatusChange("t1", "blocked");
    });

    api.patch.mockRejectedValueOnce(new Error("the worker would not let go"));
    await act(async () => {
      await board.forceHeldMove();
    });

    expect(board.forcing).toBe(false);
    expect(board.heldMove).toBeNull();
  });
});

/**
 * BP-557. `applySprintChange` filters a task out of a scoped board, so applying it before the
 * server agreed made the card vanish and come back a round trip later when the PUT failed. Free on
 * an unscoped board, where the row stays and only its badge changes; the whole screen on a scoped
 * one.
 */
describe("moving a task to another sprint", () => {
  it("waits for the server before taking the card off a scoped board", async () => {
    await mountedScoped("s1");
    let release!: (value: unknown) => void;
    api.put.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    );

    let moving!: Promise<void>;
    act(() => {
      moving = board.handleRowSprintChange("t1", "s2");
    });

    expect(board.tasks.map((t) => t._id), "still on screen while the write is out").toContain("t1");

    await act(async () => {
      release({});
      await moving;
    });

    expect(board.tasks.map((t) => t._id), "and gone once the server agreed").not.toContain("t1");
  });

  it("leaves the card where it is when the write fails", async () => {
    await mountedScoped("s1");
    api.put.mockRejectedValue(new Error("network"));

    await act(async () => {
      await board.handleRowSprintChange("t1", "s2");
    });

    expect(board.tasks.map((t) => t._id), "no flicker to undo").toContain("t1");
  });

  // The control: an unscoped board still paints immediately, because being wrong is invisible there
  it("applies at once when the card is not going anywhere", async () => {
    await mounted();
    let release!: (value: unknown) => void;
    api.put.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    );

    act(() => {
      board.handleRowSprintChange("t1", "s2");
    });

    expect(board.tasks.find((t) => t._id === "t1")!.sprint).toBe("s2");
    await act(async () => release({}));
  });
});
