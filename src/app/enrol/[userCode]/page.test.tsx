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
// The guard's job is redirecting an anonymous visitor, which is not what this file is about
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

/**
 * BP-358: this screen stopped being admin-only, so it stopped being a place where somebody decides
 * on the instance's behalf. It confirms one machine, for one person, against one repository.
 */
describe("the enrolment confirmation screen", () => {
  it("asks which project the machine should clone", async () => {
    await show();

    expect(screen.getByText(/Which repository should it set up first/i)).toBeTruthy();
    expect(screen.getByText("rig-laptop")).toBeTruthy();
  });

  // The presets wrote the project's default agent — a project-wide setting — from a screen about
  // one person's laptop. After BP-358 that field decides only what the task picker offers first.
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

  /**
   * A project with machines switched off takes the enrolment and then runs nothing, and nothing on
   * the machine itself can explain that. Located by its own testid rather than by wording: the
   * card renders several other blocks of prose in the same place.
   */
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

    // Nothing is chosen yet, so there is nothing to warn about — warning here would put a red box
    // on the screen before the person has done anything
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

    // Registration refuses this, so saying so before the click beats a toast afterwards. Located by
    // testid: both banners sit in the same place and open the same way.
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
    // BP-374: the reach sits with the project list, where a reader looks for a scope list, rather
    // than in the footer below the buttons — which is the half of the screen it contradicted
    expect(screen.getByText(/reaches every project you can/i).closest("section")).toBeTruthy();
  });
});
