// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { ApiFleetRun } from "@/types";

const { api, toast, replace, auth } = vi.hoisted(() => ({
  api: { get: vi.fn() },
  toast: vi.fn(),
  replace: vi.fn(),
  auth: { isAdmin: true, isLoading: false },
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => auth }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));

const { default: FleetRunsPage } = await import("./page");

function run(over: Partial<ApiFleetRun> = {}): ApiFleetRun {
  return {
    _id: "r1",
    taskKey: "BP-158",
    agentName: "Default",
    outcome: "failed",
    refusedBy: "",
    detail: "the build failed: 2 tests red",
    minutes: 4,
    costUsd: 0.42,
    finishedAt: new Date().toISOString(),
    projectKey: "BP",
    projectName: "Board Planner",
    workerName: "rafal-mac",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.isAdmin = true;
  auth.isLoading = false;
});

afterEach(cleanup);

describe("the fleet's run history", () => {
  it("renders what a finished run said on the way out", async () => {
    api.get.mockResolvedValue([run()]);

    render(<FleetRunsPage />);

    expect((await screen.findByTestId("run-detail")).textContent).toBe(
      "the build failed: 2 tests red"
    );
  });

  it("names the task, the project, the agent and the machine that ran it", async () => {
    api.get.mockResolvedValue([run()]);

    render(<FleetRunsPage />);

    expect(await screen.findByText("BP-158")).toBeTruthy();
    expect(screen.getByText("Board Planner")).toBeTruthy();
    expect(screen.getByText("Default")).toBeTruthy();
    expect(screen.getByText("rafal-mac")).toBeTruthy();
  });

  it("says how the run ended", async () => {
    api.get.mockResolvedValue([run()]);

    render(<FleetRunsPage />);

    expect(await screen.findByText("Failed")).toBeTruthy();
  });

  it("names the gate that refused, where there is no detail to show", async () => {
    api.get.mockResolvedValue([
      run({ outcome: "refused", refusedBy: "diff-size", detail: "" }),
    ]);

    render(<FleetRunsPage />);

    expect(await screen.findByText("Refused: diff-size")).toBeTruthy();
    expect(screen.getByTestId("run-detail-empty").textContent).toContain("diff-size");
    expect(screen.queryByTestId("run-detail")).toBeNull();
  });

  it("says so plainly when a run recorded nothing at all", async () => {
    api.get.mockResolvedValue([run({ outcome: "merged", refusedBy: "", detail: "" })]);

    render(<FleetRunsPage />);

    expect((await screen.findByTestId("run-detail-empty")).textContent).toMatch(/Nothing was recorded/);
  });

  it("says nothing has finished rather than showing an empty table", async () => {
    api.get.mockResolvedValue([]);

    render(<FleetRunsPage />);

    expect(await screen.findByText("Nothing has finished yet.")).toBeTruthy();
  });

  it("sends a non-admin away without reading anything", async () => {
    auth.isAdmin = false;

    render(<FleetRunsPage />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/projects"));
    expect(api.get).not.toHaveBeenCalled();
  });
});
