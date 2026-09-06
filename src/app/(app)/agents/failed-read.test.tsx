// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, act } from "@testing-library/react";

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

    expect(screen.getByRole("status", { name: "Loading the catalog" })).toBeTruthy();
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

    expect(screen.getByRole("status", { name: "Loading the catalog" })).toBeTruthy();
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

  // A read that answered and holds no such agent is a different answer, and must still be given
  it("still says no agent with that id when the read answers without one", async () => {
    serve([]);
    render(<AgentEditorPage />);

    await waitFor(() => expect(screen.getByText(/No agent with that id/)).toBeTruthy());
    expect(screen.queryByTestId("agent-editor-error")).toBeNull();
  });
});
