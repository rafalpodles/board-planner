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
