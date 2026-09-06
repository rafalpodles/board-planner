// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, renderHook, screen, cleanup, waitFor, fireEvent, act } from "@testing-library/react";

/**
 * BP-577. `store.ts` had no `catch`: the rejection went unhandled, the catalog stayed the empty
 * array it was initialised with, and both screens then made a claim the read had not earned —
 * "you have not created an agent yet" on the list, and "no agent with that id" on the editor,
 * which reads as deleted on a page people reach from a bookmark.
 */

const { api } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ isAdmin: true }) }));
vi.mock("@/hooks/use-projects", () => ({ useProjects: () => ({ projects: [] }) }));
vi.mock("next/navigation", () => ({ useParams: () => ({ agentId: "a1" }) }));

const { useStore } = await import("./store");
const { default: AgentsPage } = await import("./page");
const { default: AgentEditorPage } = await import("./[agentId]/page");

const AGENT = {
  _id: "a1",
  name: "Implement",
  description: "",
  scope: "user",
  composition: { steps: [], gates: [] },
};

function fail() {
  api.get.mockImplementation(() => Promise.reject(new Error("network")));
}

function serve(agents: unknown[]) {
  api.get.mockImplementation((url: string) =>
    Promise.resolve(url.includes("/api/agents") ? agents : [])
  );
}

beforeEach(() => {
  api.get.mockReset();
  api.del.mockReset();
  api.put.mockReset();
});

afterEach(cleanup);

describe("the agents catalog when the read fails", () => {
  it("says the catalog could not be read instead of claiming there are no agents", async () => {
    fail();
    render(<AgentsPage />);

    await waitFor(() => expect(screen.getByTestId("agents-catalog-error")).toBeTruthy());
    expect(screen.queryByText("You have not created an agent yet.")).toBeNull();
  });

  it("reads again on Retry", async () => {
    api.get
      .mockImplementationOnce(() => Promise.reject(new Error("network")))
      .mockImplementation(() => Promise.resolve([AGENT]));
    render(<AgentsPage />);

    await waitFor(() => expect(screen.getByTestId("agents-catalog-error")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(screen.getAllByText("Implement").length).toBeGreaterThan(0));
  });

  // The window the ticket is about: before the read answers, the page used to make the claim
  it("shows a spinner rather than the claim while the first read is in flight", async () => {
    // The page reads agents and blocks together, so both have to be released
    const pending: ((rows: unknown[]) => void)[] = [];
    api.get.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    render(<AgentsPage />);

    expect(screen.getByText("Loading the catalog")).toBeTruthy();
    expect(screen.queryByText("You have not created an agent yet.")).toBeNull();

    await act(async () => pending.forEach((resolve) => resolve([])));
    await waitFor(() =>
      expect(screen.getByText("You have not created an agent yet.")).toBeTruthy()
    );
  });

  // Retry differs from the reload every mutation runs by showing the spinner while it waits
  it("shows the spinner again while a Retry is in flight", async () => {
    const pending: ((rows: unknown[]) => void)[] = [];
    api.get.mockImplementationOnce(() => Promise.reject(new Error("network")));
    render(<AgentsPage />);
    await waitFor(() => expect(screen.getByTestId("agents-catalog-error")).toBeTruthy());

    api.get.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(screen.getByText("Loading the catalog")).toBeTruthy();
    await act(async () => pending.forEach((resolve) => resolve([])));
  });

  // A reload that fails after a mutation must not replace a catalog that is still on screen —
  // "failed to load the catalog" after a delete that succeeded is a claim of its own
  it("keeps the catalog and says the refresh failed when a mutation's reload fails", async () => {
    api.get.mockImplementation(() => Promise.resolve([AGENT]));
    api.del.mockResolvedValue({});
    render(<AgentsPage />);
    await waitFor(() => expect(screen.getAllByText("Implement").length).toBeGreaterThan(0));

    api.get.mockImplementation(() => Promise.reject(new Error("network")));
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Delete Implement"));
    });

    await waitFor(() => expect(screen.getByTestId("agents-catalog-stale")).toBeTruthy());
    expect(screen.getAllByText("Implement").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("agents-catalog-error")).toBeNull();
  });

  // An instance with blocks but no agents still has something on screen, and the guard used to
  // ask only about agents
  it("keeps blocks on screen when the reload fails and only agents are empty", async () => {
    const STEP = { _id: "b1", key: "implement", kind: "step", name: "Implement it", description: "" };
    api.get.mockImplementation((url: string) =>
      Promise.resolve(url.includes("/api/agent-blocks") ? [STEP] : [])
    );
    api.del.mockResolvedValue({});
    render(<AgentsPage />);
    await waitFor(() =>
      expect(screen.getByText("You have not created an agent yet.")).toBeTruthy()
    );

    api.get.mockImplementation(() => Promise.reject(new Error("network")));
    await act(async () => {
      fireEvent.click(screen.getAllByRole("tab").find((t) => t.textContent === "Steps")!);
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Delete Implement it"));
    });

    await waitFor(() => expect(screen.getByTestId("agents-catalog-stale")).toBeTruthy());
    expect(screen.getAllByText("Implement it").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("agents-catalog-error")).toBeNull();
  });

  // Without this control the failure branch could be rendering unconditionally
  it("still says nothing was created when the read answers with nothing", async () => {
    serve([]);
    render(<AgentsPage />);

    await waitFor(() =>
      expect(screen.getByText("You have not created an agent yet.")).toBeTruthy()
    );
    expect(screen.queryByTestId("agents-catalog-error")).toBeNull();
  });
});

describe("two reads in flight at once", () => {
  // Every mutation reloads, so overlapping reads are the normal case. A rejection that a newer
  // read has already overtaken must not hang a "may be out of date" banner over current data,
  // and a stale success must not overwrite newer rows.
  it("ignores a rejection the newer read overtook", async () => {
    const pendingRejections: ((error: Error) => void)[] = [];
    let call = 0;
    api.get.mockImplementation(() => {
      call += 1;
      if (call <= 2) {
        return new Promise((_, reject) => pendingRejections.push(reject));
      }
      return Promise.resolve([AGENT]);
    });

    const { result } = renderHook(() => useStore());

    await act(async () => {
      void result.current.reload();
    });
    await waitFor(() => expect(result.current.allAgents.length).toBe(1));

    await act(async () => pendingRejections[0](new Error("network")));

    expect(result.current.failed).toBe(false);
    expect(result.current.allAgents.length).toBe(1);
  });

  // A superseded call must not drop the spinner out from under the one still running
  it("leaves loading set when a superseded read finishes first", async () => {
    const pending: ((rows: unknown[]) => void)[] = [];
    let call = 0;
    api.get.mockImplementation(() => {
      call += 1;
      if (call <= 2) return new Promise((resolve) => pending.push(resolve));
      return new Promise(() => {});
    });

    const { result } = renderHook(() => useStore());
    await act(async () => {
      void result.current.retry();
    });

    expect(result.current.loading).toBe(true);
    await act(async () => pending.forEach((resolve) => resolve([])));

    expect(result.current.loading).toBe(true);
  });

  it("ignores a success the newer read overtook", async () => {
    const pendingResolutions: ((rows: unknown[]) => void)[] = [];
    let call = 0;
    const STALE = { ...AGENT, _id: "a0", name: "Was here first" };
    api.get.mockImplementation(() => {
      call += 1;
      if (call <= 2) {
        return new Promise((resolve) => pendingResolutions.push(resolve));
      }
      return Promise.resolve([AGENT]);
    });

    const { result } = renderHook(() => useStore());

    await act(async () => {
      void result.current.reload();
    });
    await waitFor(() => expect(result.current.allAgents.length).toBe(1));

    await act(async () => pendingResolutions.forEach((resolve) => resolve([STALE])));

    expect(result.current.allAgents.map((a) => a.name)).toEqual(["Implement"]);
  });
});

describe("the agent editor when the read fails", () => {
  it("does not say the agent does not exist", async () => {
    fail();
    render(<AgentEditorPage />);

    await waitFor(() => expect(screen.getByTestId("agent-editor-error")).toBeTruthy());
    expect(screen.queryByText(/No agent with that id/)).toBeNull();
  });

  it("reads again on Retry", async () => {
    api.get
      .mockImplementationOnce(() => Promise.reject(new Error("network")))
      .mockImplementation(() => Promise.resolve([AGENT]));
    render(<AgentEditorPage />);
    await waitFor(() => expect(screen.getByTestId("agent-editor-error")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(screen.getAllByText("Implement").length).toBeGreaterThan(0));
    expect(screen.queryByTestId("agent-editor-error")).toBeNull();
  });

  // The editor's half of the same rule: a reload that fails while the agent is on screen must
  // keep it there and say the refresh failed, not claim the agent is gone
  it("keeps the agent on screen when a later read fails", async () => {
    api.get.mockImplementationOnce(() => Promise.resolve([AGENT]));
    api.get.mockImplementationOnce(() => Promise.resolve([]));
    render(<AgentEditorPage />);
    await waitFor(() => expect(screen.getAllByText("Implement").length).toBeGreaterThan(0));

    api.get.mockImplementation(() => Promise.reject(new Error("network")));
    api.put.mockResolvedValue({});
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });

    await waitFor(() => expect(screen.getByTestId("agent-editor-stale")).toBeTruthy());
    expect(screen.getAllByText("Implement").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("agent-editor-error")).toBeNull();
    expect(screen.queryByText(/No agent with that id/)).toBeNull();
  });

  // A read that answered and holds no such agent is a different answer, and must still be given
  it("still says no agent with that id when the read answers without one", async () => {
    serve([]);
    render(<AgentEditorPage />);

    await waitFor(() => expect(screen.getByText(/No agent with that id/)).toBeTruthy());
    expect(screen.queryByTestId("agent-editor-error")).toBeNull();
  });
});
