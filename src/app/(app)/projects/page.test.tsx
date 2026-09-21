// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import type { ApiProject } from "@/types";

const { api, auth, projectsState } = vi.hoisted(() => ({
  api: { get: vi.fn() },
  auth: { isAdmin: false as boolean },
  projectsState: { projects: [] as ApiProject[], isLoading: false },
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
  api.get.mockResolvedValue([{ fullName: "Agnieszka Nowak" }, { fullName: "Tomasz Wójcik" }]);
});

afterEach(cleanup);

describe("a member on no board", () => {
  it("is told who to ask, by name", async () => {
    render(<ProjectsPage />);

    const notice = screen.getByTestId("not-on-any-board");
    await waitFor(() =>
      expect(notice.textContent).toBe(
        "You are not on any board yet.Boards are opened to you by their owners. Ask one of the admins: Agnieszka Nowak, Tomasz Wójcik."
      )
    );
    expect(api.get).toHaveBeenCalledWith("/api/users/admins");
    expect(screen.queryByText("No projects yet")).toBeNull();
  });

  it("still explains where boards come from when the names cannot be read", async () => {
    api.get.mockRejectedValue(new Error("offline"));

    render(<ProjectsPage />);

    await waitFor(() => expect(api.get).toHaveBeenCalled());
    const notice = screen.getByTestId("not-on-any-board");
    expect(notice.textContent).toContain("Boards are opened to you by their owners.");
    expect(notice.textContent).not.toContain("Ask one of the admins");
  });
});

describe("an admin on an instance with no boards", () => {
  it("is offered the first board rather than a list of admins", () => {
    auth.isAdmin = true;

    render(<ProjectsPage />);

    expect(screen.getByText("No projects yet")).toBeTruthy();
    expect(screen.queryByTestId("not-on-any-board")).toBeNull();
    expect(api.get).not.toHaveBeenCalled();
  });
});
