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

function renderSidebar(
  props: {
    mobileOpen?: boolean;
    onCloseMobile?: () => void;
    menuButtonRef?: React.RefObject<HTMLElement | null>;
    onOpenSearch?: () => void;
  } = {}
) {
  return render(
    <Sidebar
      mobileOpen={props.mobileOpen ?? false}
      onNavigate={() => {}}
      onCloseMobile={props.onCloseMobile ?? (() => {})}
      menuButtonRef={props.menuButtonRef}
      onOpenSearch={props.onOpenSearch ?? (() => {})}
    />
  );
}

// jsdom/happy-dom answer every media query with false, so the drawer branch only
// runs when matchMedia is told the viewport is narrow
function setViewport(mobile: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: mobile && query.includes("max-width"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  api.get.mockReset();
  api.get.mockImplementation((url: string) =>
    Promise.resolve(url.startsWith("/api/search") ? [] : { count: 0 })
  );
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

// The drawer painted a scrim and blocked the page visually, but owed it none of
// a modal's actual contract: Escape did nothing and Tab walked straight past it
describe("Sidebar as a mobile drawer", () => {
  afterEach(() => setViewport(false));

  it("presents itself as a dialog only while it is a drawer", async () => {
    setViewport(true);
    const { container } = renderSidebar({ mobileOpen: true });
    await waitFor(() => {
      const aside = container.querySelector("aside")!;
      expect(aside.getAttribute("role")).toBe("dialog");
      expect(aside.getAttribute("aria-modal")).toBe("true");
      expect(aside.getAttribute("aria-label")).toBe("Navigation");
    });
  });

  it("is plain layout above the breakpoint, even when mobileOpen is set", async () => {
    setViewport(false);
    const { container } = renderSidebar({ mobileOpen: true });
    await waitFor(() => expect(screen.getByText("My Tasks")).toBeTruthy());
    const aside = container.querySelector("aside")!;
    expect(aside.getAttribute("role")).toBeNull();
    expect(aside.getAttribute("aria-modal")).toBeNull();
  });

  it("closes on Escape", async () => {
    setViewport(true);
    const onCloseMobile = vi.fn();
    renderSidebar({ mobileOpen: true, onCloseMobile });
    await waitFor(() => expect(screen.getByLabelText("Close navigation")).toBeTruthy());

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onCloseMobile).toHaveBeenCalledTimes(1);
  });

  it("does not answer Escape when it is not a drawer", async () => {
    setViewport(false);
    const onCloseMobile = vi.fn();
    renderSidebar({ mobileOpen: false, onCloseMobile });
    await waitFor(() => expect(screen.getByText("My Tasks")).toBeTruthy());

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onCloseMobile).not.toHaveBeenCalled();
  });

  it("keeps Tab inside itself", async () => {
    setViewport(true);
    const { container } = renderSidebar({ mobileOpen: true });
    const aside = await waitFor(() => container.querySelector("aside")!);
    const stops = [...aside.querySelectorAll<HTMLElement>("a[href], button")];
    const last = stops[stops.length - 1];

    last.focus();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    });
    expect(aside.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(stops[0]);
  });

  it("labels its close control for the drawer, not the desktop rail", async () => {
    setViewport(true);
    renderSidebar({ mobileOpen: true });
    await waitFor(() => expect(screen.getByLabelText("Close navigation")).toBeTruthy());
    expect(screen.queryByLabelText("Collapse sidebar")).toBeNull();
  });

  it("closes when that control is used", async () => {
    setViewport(true);
    const onCloseMobile = vi.fn();
    renderSidebar({ mobileOpen: true, onCloseMobile });
    const close = await screen.findByLabelText("Close navigation");
    await act(async () => close.click());
    expect(onCloseMobile).toHaveBeenCalledTimes(1);
  });

  it("still says Collapse sidebar on the desktop layout", async () => {
    setViewport(false);
    renderSidebar({ mobileOpen: false });
    await waitFor(() => expect(screen.getByLabelText("Collapse sidebar")).toBeTruthy());
  });

  it("returns focus to whatever opened it", async () => {
    setViewport(true);
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    const menuButtonRef = { current: trigger };

    const { unmount } = renderSidebar({ mobileOpen: true, menuButtonRef });
    await waitFor(() => expect(screen.getByLabelText("Close navigation")).toBeTruthy());
    await act(async () => unmount());

    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});

// CP-197 moved search out of the sidebar into a single centered layer; what is
// left here is a trigger, and the nav must never be replaced by results again
describe("Sidebar search row", () => {
  it("opens the search layer instead of searching in place", async () => {
    const onOpenSearch = vi.fn();
    renderSidebar({ onOpenSearch });
    const row = await screen.findByRole("button", { name: "Search" });

    await act(async () => row.click());
    expect(onOpenSearch).toHaveBeenCalled();
  });

  // It stopped being a field when it stopped searching; looking like one was the lie
  it("looks like the other nav rows, not like an input", async () => {
    renderSidebar();
    const row = await screen.findByRole("button", { name: "Search" });
    const myTasks = screen.getByText("My Tasks").closest("a")!;

    expect(row.className).toBe(myTasks.className);
    expect(row.querySelector("kbd")).toBeNull();
  });

  it("still announces the shortcut that reaches it", async () => {
    renderSidebar();
    const row = await screen.findByRole("button", { name: "Search" });
    expect(row.getAttribute("aria-keyshortcuts")).toBe("Meta+K Control+K");
  });

  it("sits in the same list position whether the rail is open or collapsed", async () => {
    const namesInOrder = () =>
      [...document.querySelectorAll("nav a, nav button")]
        .map((el) => el.textContent?.trim() || el.getAttribute("aria-label"))
        .slice(0, 3);

    renderSidebar();
    await waitFor(() => expect(screen.getByText("My Tasks")).toBeTruthy());
    expect(namesInOrder()[0]).toBe("Search");

    cleanup();
    localStorage.setItem("sidebar-collapsed", "1");
    renderSidebar();
    await waitFor(() => expect(screen.queryByText("My Tasks")).toBeNull());
    expect(namesInOrder()[0]).toBe("Search");
  });

  it("never puts a search field or results in the nav", async () => {
    renderSidebar();
    await waitFor(() => expect(screen.getByText("My Tasks")).toBeTruthy());
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("keeps a way into search from the collapsed rail", async () => {
    const onOpenSearch = vi.fn();
    localStorage.setItem("sidebar-collapsed", "1");
    renderSidebar({ onOpenSearch });
    await waitFor(() => expect(screen.queryByText("My Tasks")).toBeNull());

    await act(async () => screen.getByRole("button", { name: "Search" }).click());
    expect(onOpenSearch).toHaveBeenCalled();
  });
});
