// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import { Sidebar } from "./Sidebar";

const { api, auth, nav, theme, projectsState } = vi.hoisted(() => ({
  api: { get: vi.fn() },
  auth: {
    user: null as { fullName: string; role: string } | null,
    isAdmin: true,
    logout: vi.fn(),
  },
  nav: { pathname: "/projects" },
  theme: { theme: "dark", toggle: vi.fn() },
  projectsState: { projects: [] as unknown[], isLoading: false, reload: vi.fn() },
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => auth }));
vi.mock("@/hooks/use-projects", () => ({ useProjects: () => projectsState }));
vi.mock("@/components/ThemeProvider", () => ({ useTheme: () => theme }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ replace: vi.fn() }),
}));
vi.mock("next/image", () => ({
  default: (props: { alt?: string }) => <span data-testid="logo" aria-label={props.alt} />,
}));

function renderSidebar(props: { mobileOpen?: boolean } = {}) {
  return render(
    <Sidebar
      mobileOpen={props.mobileOpen ?? false}
      onNavigate={() => {}}
      onOpenImport={() => {}}
      onOpenExport={() => {}}
    />
  );
}

beforeEach(() => {
  api.get.mockReset();
  api.get.mockResolvedValue({ count: 0 });
  auth.user = { fullName: "Admin User", role: "admin" };
  auth.isAdmin = true;
  nav.pathname = "/projects";
  projectsState.projects = [];
  localStorage.clear();
});

afterEach(cleanup);

describe("Sidebar", () => {
  it("renders nothing until a user is known", () => {
    auth.user = null;
    const { container } = renderSidebar();
    expect(container.querySelector("aside")).toBeNull();
  });

  it("shows no unread badge at zero", async () => {
    api.get.mockResolvedValue({ count: 0 });
    renderSidebar();
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(screen.queryByText("0")).toBeNull();
  });

  it("shows the unread count", async () => {
    api.get.mockResolvedValue({ count: 3 });
    renderSidebar();
    expect(await screen.findByText("3")).toBeTruthy();
  });

  it("caps the unread count at 99+", async () => {
    api.get.mockResolvedValue({ count: 150 });
    renderSidebar();
    expect(await screen.findByText("99+")).toBeTruthy();
    expect(screen.queryByText("150")).toBeNull();
  });

  it("hides labels when collapsed on desktop", async () => {
    localStorage.setItem("sidebar-collapsed", "1");
    renderSidebar({ mobileOpen: false });
    await waitFor(() => expect(screen.queryByText("My Tasks")).toBeNull());
    // The icon still has to name itself for anyone hovering the rail
    expect(screen.getByTitle("My Tasks")).toBeTruthy();
  });

  // The drawer is always 260px wide, so a stored collapse must not strip its labels
  it("keeps labels when the drawer is open, even if collapse is stored", async () => {
    localStorage.setItem("sidebar-collapsed", "1");
    renderSidebar({ mobileOpen: true });
    expect(await screen.findByText("My Tasks")).toBeTruthy();
    expect(screen.getByText("Notifications")).toBeTruthy();
  });

  it("shows labels when not collapsed", async () => {
    renderSidebar();
    expect(await screen.findByText("My Tasks")).toBeTruthy();
  });

  it("round-trips the collapse choice through localStorage", async () => {
    renderSidebar();
    await screen.findByText("My Tasks");

    await act(async () => {
      screen.getByLabelText("Collapse sidebar").click();
    });

    expect(localStorage.getItem("sidebar-collapsed")).toBe("1");
    expect(screen.queryByText("My Tasks")).toBeNull();

    await act(async () => {
      screen.getByLabelText("Expand sidebar").click();
    });

    expect(localStorage.getItem("sidebar-collapsed")).toBe("0");
    expect(screen.getByText("My Tasks")).toBeTruthy();
  });

  it("keeps the parent nav item active on a nested route", async () => {
    nav.pathname = "/settings/users";
    renderSidebar();
    const settings = await screen.findByText("Settings");
    expect(settings.closest("a")?.getAttribute("aria-current")).toBe("page");

    const myTasks = screen.getByText("My Tasks");
    expect(myTasks.closest("a")?.getAttribute("aria-current")).toBeNull();
  });

  // The expanded sidebar hands the Projects group to ProjectTree; only the
  // collapsed rail still renders a single flat entry
  it("falls back to one All projects entry on the collapsed rail", async () => {
    localStorage.setItem("sidebar-collapsed", "1");
    nav.pathname = "/projects/TP/tasks/1";
    renderSidebar({ mobileOpen: false });
    const entry = await screen.findByTitle("All projects");
    expect(entry.getAttribute("aria-current")).toBe("page");
  });
});
