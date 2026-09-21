// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { ApiProject } from "@/types";

const { api, auth, projectsState } = vi.hoisted(() => ({
  api: { get: vi.fn() },
  auth: { isAdmin: false as boolean },
  projectsState: {
    projects: [] as ApiProject[],
    isLoading: false,
    loadFailed: false,
    retrying: false,
    reload: vi.fn(),
  },
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => auth }));
vi.mock("@/hooks/use-projects", () => ({ useProjects: () => projectsState }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/projects",
}));

const { default: ProjectsPage } = await import("./page");

beforeEach(() => {
  vi.clearAllMocks();
  auth.isAdmin = false;
  projectsState.projects = [];
  projectsState.loadFailed = false;
  projectsState.retrying = false;
});

afterEach(cleanup);

describe("a member on no board", () => {
  it("is told only that there are no boards, and reads no other accounts", () => {
    render(<ProjectsPage />);

    expect(screen.getByTestId("not-on-any-board").textContent).toBe("You are not on any board yet.");
    expect(api.get).not.toHaveBeenCalled();
    expect(screen.queryByText("No projects yet")).toBeNull();
  });
});

describe("an admin on an instance with no boards", () => {
  it("is offered the first board", () => {
    auth.isAdmin = true;

    render(<ProjectsPage />);

    expect(screen.getByText("No projects yet")).toBeTruthy();
    expect(screen.queryByTestId("not-on-any-board")).toBeNull();
    expect(api.get).not.toHaveBeenCalled();
  });
});

// A read that failed says nothing about which boards exist, least of all that there are none
describe("when the boards could not be read", () => {
  it.each([false, true])("shows the failure and a retry, not an empty state (admin: %s)", (admin) => {
    auth.isAdmin = admin;
    projectsState.loadFailed = true;

    render(<ProjectsPage />);

    expect(screen.getByTestId("projects-load-failed").textContent).toContain(
      "Your boards could not be loaded."
    );
    expect(screen.queryByTestId("not-on-any-board")).toBeNull();
    expect(screen.queryByText("No projects yet")).toBeNull();
    expect(screen.queryByText("0 projects")).toBeNull();

    screen.getByRole("button", { name: "Retry" }).click();
    expect(projectsState.reload).toHaveBeenCalled();
  });

  it("shows the retry as busy while it runs", () => {
    projectsState.loadFailed = true;
    projectsState.retrying = true;

    render(<ProjectsPage />);

    expect(screen.getByRole("button", { name: "Retrying…" })).toBeTruthy();
  });
});
