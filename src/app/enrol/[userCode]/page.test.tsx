// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";

const { api, toast } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn() },
  toast: vi.fn(),
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { username: "rpo", fullName: "Rafal Podles" } }),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/components/AuthGuard", () => ({
  AuthGuard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("next/image", () => ({ default: () => null }));

const { default: EnrolPage } = await import("./page");

const MINE = "69a52e3b399b27d3cbb2c5a5";

function view(over: Record<string, unknown> = {}) {
  return {
    userCode: "ABCD-1234",
    machineName: "rig-laptop",
    machineHost: "mac.home",
    status: "pending",
    expiresAt: new Date("2026-08-17T12:15:00.000Z").toISOString(),
    projects: [
      {
        _id: MINE,
        name: "Board Planner",
        key: "BP",
        repositoryUrl: "git@github.com:owner/repo.git",
        workersEnabled: true,
        canEnable: false,
      },
    ],
    existingWorker: null,
    ...over,
  };
}

async function show(over: Record<string, unknown> = {}) {
  api.get.mockResolvedValue(view(over));
  await act(async () => {
    render(<EnrolPage params={Promise.resolve({ userCode: "ABCD-1234" })} />);
  });
}

async function chooseTheProject() {
  await act(async () => screen.getByRole("radio").click());
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("the enrolment confirmation screen", () => {
  it("asks which repository the machine should set up first", async () => {
    await show();

    expect(screen.getByText(/Which repository should it set up first/i)).toBeTruthy();
    expect(screen.getByText("rig-laptop")).toBeTruthy();
  });

  it("no longer asks how much the machine should do on its own", async () => {
    await show();

    expect(screen.queryByText(/How much should it do on its own/i)).toBeNull();
    expect(screen.queryByRole("radio", { name: /Write, review and merge/i })).toBeNull();
  });

  it("sends only the project, with no preset", async () => {
    await show();
    await chooseTheProject();

    await act(async () => screen.getByRole("button", { name: /Connect it/i }).click());

    expect(api.post).toHaveBeenCalledWith(
      "/api/workers/enrolment/device/ABCD-1234/approve",
      { projectId: MINE }
    );
  });

  describe("a project that will not run it", () => {
    it("warns when machines are off and this person cannot turn them on", async () => {
      await show({
        projects: [{ ...view().projects[0], workersEnabled: false, canEnable: false }],
      });
      await chooseTheProject();

      expect(screen.getByTestId("workers-off-warning")).toBeTruthy();
    });

    it("stays quiet when this person could turn them on", async () => {
      await show({
        projects: [{ ...view().projects[0], workersEnabled: false, canEnable: true }],
      });
      await chooseTheProject();

      expect(screen.queryByTestId("workers-off-warning")).toBeNull();
    });

    it("stays quiet when machines are already on", async () => {
      await show();
      await chooseTheProject();

      expect(screen.queryByTestId("workers-off-warning")).toBeNull();
    });

    it("stays quiet before a project is picked", async () => {
      await show({
        projects: [{ ...view().projects[0], workersEnabled: false, canEnable: false }],
      });

      expect(screen.queryByTestId("workers-off-warning")).toBeNull();
    });
  });

  describe("a machine of this name that is already enrolled", () => {
    it("warns that connecting replaces the credential of one that is yours", async () => {
      await show({ existingWorker: { mine: true } });

      expect(screen.getByTestId("already-registered")).toBeTruthy();
      expect(screen.queryByTestId("belongs-to-somebody-else")).toBeNull();
    });

    it("says outright that somebody else's will be refused", async () => {
      await show({ existingWorker: { mine: false } });

      expect(screen.getByTestId("belongs-to-somebody-else")).toBeTruthy();
      expect(screen.queryByTestId("already-registered")).toBeNull();
    });

    it("warns about neither when there is no such machine", async () => {
      await show();

      expect(screen.queryByTestId("already-registered")).toBeNull();
      expect(screen.queryByTestId("belongs-to-somebody-else")).toBeNull();
    });
  });

  it("says whose account the machine will act under, and what it will reach", async () => {
    await show();

    expect(screen.getByText(/Connecting as Rafal Podles/i)).toBeTruthy();
    expect(screen.getByText(/reaches every project you can/i).closest("section")).toBeTruthy();
  });
});
