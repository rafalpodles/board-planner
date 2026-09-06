// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, act } from "@testing-library/react";
import { ProjectsProvider } from "@/components/shell/ProjectsProvider";
import { useProjects } from "@/hooks/use-projects";

const { api, auth } = vi.hoisted(() => ({
  api: { get: vi.fn(), put: vi.fn() },
  auth: { user: null as { username: string } | null },
}));

// useApi must hand back a stable object: use-projects depends on it, and a fresh
// identity per render would re-run the fetch effect forever
vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => auth }));

function Probe({ newOrder }: { newOrder?: string[] } = {}) {
  const { projects, isLoading, reload, reorder } = useProjects();
  return (
    <div>
      <span data-testid="loading">{String(isLoading)}</span>
      <span data-testid="count">{projects.length}</span>
      <span data-testid="order">{projects.map((p) => p._id).join(",")}</span>
      <button onClick={() => reload()}>reload</button>
      <button onClick={() => reorder(newOrder ?? [])}>reorder</button>
    </div>
  );
}

function renderProvider(newOrder?: string[]) {
  return render(
    <ProjectsProvider>
      <Probe newOrder={newOrder} />
    </ProjectsProvider>
  );
}

beforeEach(() => {
  api.get.mockReset();
  api.put.mockReset();
  api.put.mockResolvedValue({ updated: 0 });
  auth.user = { username: "admin" };
});

afterEach(cleanup);

describe("useProjects", () => {
  it("fetches the project list once when a user is signed in", async () => {
    api.get.mockResolvedValue([{ _id: "1" }, { _id: "2" }]);

    renderProvider();

    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("2"));
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledWith("/api/projects");
    expect(screen.getByTestId("loading").textContent).toBe("false");
  });

  it("does not fetch when there is no user, and reports no projects", async () => {
    auth.user = null;

    renderProvider();

    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("false"));
    expect(api.get).not.toHaveBeenCalled();
    expect(screen.getByTestId("count").textContent).toBe("0");
  });

  // A rejected request must not leave the shell stuck rendering a spinner forever
  it("clears loading when the request fails", async () => {
    api.get.mockRejectedValue(new Error("boom"));

    renderProvider();

    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("false"));
    expect(screen.getByTestId("count").textContent).toBe("0");
  });

  it("refetches on reload()", async () => {
    api.get.mockResolvedValue([{ _id: "1" }]);

    renderProvider();
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("1"));

    api.get.mockResolvedValue([{ _id: "1" }, { _id: "2" }, { _id: "3" }]);
    await act(async () => {
      screen.getByText("reload").click();
    });

    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("3"));
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  // Every page now assumes the shell mounted the provider, so the failure has to be loud
  it("throws when used outside the provider", () => {
    const silence = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/must be used within ProjectsProvider/);
    silence.mockRestore();
  });
});

// The sidebar must show the row where it was dropped, not where it was a
// round-trip ago — and must not keep a position the server refused
describe("useProjects reorder", () => {
  const three = [{ _id: "a" }, { _id: "b" }, { _id: "c" }];

  it("applies the new order before the request resolves", async () => {
    api.get.mockResolvedValue(three);
    let resolvePut: () => void = () => {};
    api.put.mockReturnValue(new Promise<void>((r) => (resolvePut = r)));

    renderProvider(["c", "a", "b"]);
    await waitFor(() => expect(screen.getByTestId("order").textContent).toBe("a,b,c"));

    await act(async () => screen.getByText("reorder").click());
    expect(screen.getByTestId("order").textContent).toBe("c,a,b");

    await act(async () => resolvePut());
    expect(screen.getByTestId("order").textContent).toBe("c,a,b");
  });

  it("sends the ids in the new order", async () => {
    api.get.mockResolvedValue(three);
    renderProvider(["c", "a", "b"]);
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("3"));

    await act(async () => screen.getByText("reorder").click());
    expect(api.put).toHaveBeenCalledWith("/api/projects/reorder", {
      order: ["c", "a", "b"],
    });
  });

  it("snaps back when the write fails", async () => {
    api.get.mockResolvedValue(three);
    api.put.mockRejectedValue(new Error("boom"));

    renderProvider(["c", "a", "b"]);
    await waitFor(() => expect(screen.getByTestId("order").textContent).toBe("a,b,c"));

    await act(async () => screen.getByText("reorder").click());
    await waitFor(() => expect(screen.getByTestId("order").textContent).toBe("a,b,c"));
  });

  // A truncated or padded list would drop or duplicate a project on screen
  it("refuses an order that is not a permutation of what it holds", async () => {
    api.get.mockResolvedValue(three);
    renderProvider(["a", "b"]);
    await waitFor(() => expect(screen.getByTestId("order").textContent).toBe("a,b,c"));

    await act(async () => screen.getByText("reorder").click());
    expect(screen.getByTestId("order").textContent).toBe("a,b,c");
    expect(api.put).not.toHaveBeenCalled();
  });
});

// BP-551: what a request applies depends on what happened while it was in flight, not on when it
// happens to come back
describe("useProjects overtaken requests", () => {
  const three = [{ _id: "a" }, { _id: "b" }, { _id: "c" }];

  /** A `get` that is answered only when the returned callback is called. */
  function heldGet() {
    let deliver: (value: unknown) => void = () => {};
    api.get.mockReturnValueOnce(new Promise((resolve) => (deliver = resolve)));
    return (value: unknown) => deliver(value);
  }

  it("ignores a read that a later read overtook", async () => {
    api.get.mockResolvedValue([{ _id: "1" }]);
    renderProvider();
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("1"));

    const deliverFirst = heldGet();
    await act(async () => screen.getByText("reload").click());

    api.get.mockResolvedValue([{ _id: "1" }, { _id: "2" }]);
    await act(async () => screen.getByText("reload").click());
    expect(screen.getByTestId("count").textContent).toBe("2");

    await act(async () => deliverFirst([{ _id: "9" }, { _id: "8" }, { _id: "7" }]));
    expect(screen.getByTestId("count").textContent).toBe("2");
  });

  it("ignores a read that a reorder overtook", async () => {
    api.get.mockResolvedValue(three);
    renderProvider(["c", "a", "b"]);
    await waitFor(() => expect(screen.getByTestId("order").textContent).toBe("a,b,c"));

    const deliverStale = heldGet();
    await act(async () => screen.getByText("reload").click());

    await act(async () => screen.getByText("reorder").click());
    expect(screen.getByTestId("order").textContent).toBe("c,a,b");

    // The order the server held when that read was answered, arriving after the drop
    await act(async () => deliverStale(three));
    expect(screen.getByTestId("order").textContent).toBe("c,a,b");
  });

  it("does not snap a failed reorder back over a later one", async () => {
    api.get.mockResolvedValue(three);
    let failFirst: (reason: Error) => void = () => {};
    api.put.mockReturnValueOnce(new Promise((_, reject) => (failFirst = reject)));

    const { rerender } = renderProvider(["c", "a", "b"]);
    await waitFor(() => expect(screen.getByTestId("order").textContent).toBe("a,b,c"));

    await act(async () => screen.getByText("reorder").click());
    expect(screen.getByTestId("order").textContent).toBe("c,a,b");

    api.put.mockResolvedValue({ updated: 3 });
    rerender(
      <ProjectsProvider>
        <Probe newOrder={["b", "c", "a"]} />
      </ProjectsProvider>
    );
    await act(async () => screen.getByText("reorder").click());
    expect(screen.getByTestId("order").textContent).toBe("b,c,a");

    await act(async () => failFirst(new Error("boom")));
    expect(screen.getByTestId("order").textContent).toBe("b,c,a");
  });

  // The counter is bumped by the reorder, so a read issued AFTER one must still win. Without this
  // a guard that simply stopped reading once a drag had happened would pass every test above,
  // and the sidebar would stop showing renames and new boards for the rest of the session
  it("applies a read issued after a reorder", async () => {
    api.get.mockResolvedValue(three);
    renderProvider(["c", "a", "b"]);
    await waitFor(() => expect(screen.getByTestId("order").textContent).toBe("a,b,c"));

    await act(async () => screen.getByText("reorder").click());
    expect(screen.getByTestId("order").textContent).toBe("c,a,b");

    api.get.mockResolvedValue([{ _id: "b" }, { _id: "c" }, { _id: "a" }]);
    await act(async () => screen.getByText("reload").click());
    expect(screen.getByTestId("order").textContent).toBe("b,c,a");
  });

  // The failure path needs the guard as much as the success path: a stale read that rejects —
  // aborted on navigation, say — would otherwise blank a sidebar a later read had already filled
  it("does not blank the list when an overtaken read fails", async () => {
    api.get.mockResolvedValue(three);
    renderProvider();
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("3"));

    let failFirst: (reason: Error) => void = () => {};
    api.get.mockReturnValueOnce(new Promise((_, reject) => (failFirst = reject)));
    await act(async () => screen.getByText("reload").click());

    await act(async () => screen.getByText("reload").click());
    expect(screen.getByTestId("count").textContent).toBe("3");

    await act(async () => failFirst(new Error("aborted")));
    expect(screen.getByTestId("count").textContent).toBe("3");
  });

  // Nothing can be reordered before the first read lands, and letting it through would advance the
  // counter with no request behind it — leaving that read discarded and the shell loading for ever
  it("refuses to reorder a list it has not loaded yet", async () => {
    let deliver: (value: unknown) => void = () => {};
    api.get.mockReturnValueOnce(new Promise((resolve) => (deliver = resolve)));

    renderProvider(["c", "a", "b"]);
    expect(screen.getByTestId("loading").textContent).toBe("true");

    await act(async () => screen.getByText("reorder").click());
    expect(api.put).not.toHaveBeenCalled();

    await act(async () => deliver(three));
    expect(screen.getByTestId("order").textContent).toBe("a,b,c");
    expect(screen.getByTestId("loading").textContent).toBe("false");
  });
});
