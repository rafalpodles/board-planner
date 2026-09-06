// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";

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

  // A read that answered and holds no such agent is a different answer, and must still be given
  it("still says no agent with that id when the read answers without one", async () => {
    serve([]);
    render(<AgentEditorPage />);

    await waitFor(() => expect(screen.getByText(/No agent with that id/)).toBeTruthy());
    expect(screen.queryByTestId("agent-editor-error")).toBeNull();
  });
});
