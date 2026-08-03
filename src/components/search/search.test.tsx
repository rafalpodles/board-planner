// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, act, waitFor } from "@testing-library/react";
import { matchProjects, toHits, groupOf, sortByGroup } from "./use-search";
import { SearchLayer } from "./SearchLayer";
import { ApiProject, ApiTask } from "@/types";

function project(over: Partial<ApiProject> & { _id: string; key: string }): ApiProject {
  return { name: `Project ${over.key}`, icon: "📋", ...over } as ApiProject;
}

const projects = [
  project({ _id: "p1", key: "TP", name: "Test Project" }),
  project({ _id: "p2", key: "MOB", name: "Mobile App" }),
];

const task = {
  _id: "t1",
  taskNumber: 42,
  title: "Fix the login redirect",
  status: "todo",
  project: { _id: "p1", key: "TP", name: "Test Project" },
} as unknown as ApiTask;

afterEach(cleanup);

describe("matchProjects", () => {
  it("matches on name, case-insensitively", () => {
    expect(matchProjects(projects, "mobile").map((p) => p.key)).toEqual(["MOB"]);
    expect(matchProjects(projects, "MOBILE").map((p) => p.key)).toEqual(["MOB"]);
  });

  it("matches on key", () => {
    expect(matchProjects(projects, "tp").map((p) => p.key)).toEqual(["TP"]);
  });

  it("returns nothing for an empty query rather than everything", () => {
    expect(matchProjects(projects, "   ")).toEqual([]);
  });
});

describe("toHits", () => {
  it("puts projects before tasks", () => {
    const hits = toHits(projects, [task]);
    expect(hits.map((h) => h.kind)).toEqual(["project", "project", "task"]);
  });

  it("links a task by its project key, not its id", () => {
    const [hit] = toHits([], [task]);
    expect(hit.href).toBe("/projects/TP/tasks/42");
    expect(hit.meta).toBe("TP-42");
  });

  // A task whose project came back unpopulated still has to be reachable
  it("falls back to the raw project ref when the project is not populated", () => {
    const bare = { ...task, project: "p1" } as unknown as ApiTask;
    const [hit] = toHits([], [bare]);
    expect(hit.href).toBe("/projects/p1/tasks/42");
    expect(hit.meta).toBe("#42");
  });

  it("links a project by key", () => {
    const [hit] = toHits([projects[0]], []);
    expect(hit.href).toBe("/projects/TP");
  });

  it("carries the status and project name the wide rows show", () => {
    const [hit] = toHits([], [task]);
    expect(hit.status).toBe("todo");
    expect(hit.projectName).toBe("Test Project");
  });
});

describe("grouping", () => {
  const hits = toHits(projects, [task]);

  it("counts a hit as current whether the route carries the key or the id", () => {
    expect(groupOf(hits[2], "TP")).toBe("current");
    expect(groupOf(hits[2], "tp")).toBe("current");
    expect(groupOf(hits[2], "p1")).toBe("current");
    expect(groupOf(hits[2], "MOB")).toBe("other");
  });

  it("treats everything as other when no project is in the route", () => {
    expect(hits.every((h) => groupOf(h, undefined) === "other")).toBe(true);
  });

  it("sorts the current project's hits into one contiguous run at the top", () => {
    expect(sortByGroup(hits, "MOB").map((h) => h.meta)).toEqual(["MOB", "TP", "TP-42"]);
  });

  it("leaves the order alone when there is no current project", () => {
    expect(sortByGroup(hits, undefined)).toEqual(hits);
  });
});

const { api, projectsState, pathname, push } = vi.hoisted(() => ({
  api: { get: vi.fn() },
  projectsState: { projects: [] as unknown[] },
  pathname: { value: "/my-tasks" },
  push: vi.fn(),
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/hooks/use-projects", () => ({ useProjects: () => projectsState }));
vi.mock("next/navigation", () => ({
  usePathname: () => pathname.value,
  useRouter: () => ({ push }),
}));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

describe("SearchLayer", () => {
  beforeEach(() => {
    api.get.mockReset();
    api.get.mockResolvedValue([]);
    push.mockReset();
    projectsState.projects = [];
    pathname.value = "/my-tasks";
  });

  function renderLayer(open = true) {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const view = render(<SearchLayer open={open} onOpen={onOpen} onClose={onClose} />);
    return { ...view, onOpen, onClose };
  }

  function type(value: string) {
    const input = screen.getByLabelText("Search tasks and projects") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return input;
  }

  function press(key: string) {
    screen
      .getByLabelText("Search tasks and projects")
      .dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  }

  it("renders nothing at all while closed", () => {
    renderLayer(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens on the shortcut from anywhere, closed sidebar or not", () => {
    const { onOpen } = renderLayer(false);
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })
      );
    });
    expect(onOpen).toHaveBeenCalledTimes(1);

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true }));
    });
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  // Otherwise the shortcut eats a slash the moment anyone types a path or a URL
  it("does not open on / while the caret is in a field", () => {
    const { onOpen } = renderLayer(false);
    for (const tag of ["input", "textarea", "select"] as const) {
      const el = document.createElement(tag);
      document.body.appendChild(el);
      act(() => {
        el.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true }));
      });
      el.remove();
    }
    const editable = document.createElement("div");
    Object.defineProperty(editable, "isContentEditable", { value: true });
    document.body.appendChild(editable);
    act(() => {
      editable.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true }));
    });
    editable.remove();

    expect(onOpen).not.toHaveBeenCalled();
  });

  it("asks for a longer query before it searches", () => {
    renderLayer();
    act(() => void type("a"));
    expect(screen.getByText(/Type at least 2 characters/)).toBeTruthy();
    expect(api.get).not.toHaveBeenCalled();
  });

  it("finds a project by name and links it", async () => {
    projectsState.projects = [{ _id: "p1", key: "MOB", name: "Mobile App", icon: "📱" }];
    renderLayer();
    await act(async () => void type("mobile"));

    await waitFor(() => expect(screen.getByRole("option")).toBeTruthy());
    expect(screen.getByRole("option").textContent).toContain("Mobile App");
  });

  it("groups the current project's hits above the rest", async () => {
    pathname.value = "/projects/MOB/tasks/1";
    projectsState.projects = [
      { _id: "p1", key: "MOB", name: "Mobile App", icon: "📱" },
      { _id: "p2", key: "MOBX", name: "Mobile Extra", icon: "📱" },
    ];
    renderLayer();
    await act(async () => void type("mobile"));

    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    expect(screen.getByText("In this project")).toBeTruthy();
    expect(screen.getByText("Other projects")).toBeTruthy();
    expect(screen.getAllByRole("option")[0].textContent).toContain("Mobile App");

    // a listbox owes its options a group, not a bare div, or the heading is
    // decoration and the grouping never reaches a screen reader
    const groups = screen.getAllByRole("group");
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual([
      "In this project",
      "Other projects",
    ]);
    for (const option of screen.getAllByRole("option")) {
      expect(option.parentElement?.getAttribute("role")).toBe("group");
    }
  });

  it("leaves the groups off when the route has no project", async () => {
    projectsState.projects = [{ _id: "p1", key: "MOB", name: "Mobile App", icon: "📱" }];
    renderLayer();
    await act(async () => void type("mobile"));

    await waitFor(() => expect(screen.getByRole("option")).toBeTruthy());
    expect(screen.queryByText("In this project")).toBeNull();
    expect(screen.queryByText("Other projects")).toBeNull();
  });

  // Columns are project-defined, so the generic STATUS_LABELS map renders an
  // empty badge for a custom column and the wrong name for a renamed one
  it("labels a hit with its own project's column, not the built-in status name", async () => {
    projectsState.projects = [
      {
        _id: "p1",
        key: "MOB",
        name: "Mobile App",
        icon: "📱",
        columns: [
          { id: "qa_review", label: "QA Review", color: "#14b8a6" },
          { id: "in_review", label: "Code Review", color: "#a855f7" },
        ],
      },
    ];
    api.get.mockResolvedValue([
      {
        _id: "t1",
        taskNumber: 7,
        title: "Custom column task",
        status: "qa_review",
        project: { _id: "p1", key: "MOB", name: "Mobile App" },
      },
      {
        _id: "t2",
        taskNumber: 8,
        title: "Renamed column task",
        status: "in_review",
        project: { _id: "p1", key: "MOB", name: "Mobile App" },
      },
    ]);
    renderLayer();
    await act(async () => void type("column"));

    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    expect(screen.getByText("QA Review")).toBeTruthy();
    expect(screen.getByText("Code Review")).toBeTruthy();
    expect(screen.queryByText("In Review")).toBeNull();
  });

  it("still names a status when the project is unknown to the sidebar", async () => {
    api.get.mockResolvedValue([
      {
        _id: "t1",
        taskNumber: 7,
        title: "Orphan task",
        status: "todo",
        project: { _id: "zz", key: "ZZ", name: "Elsewhere" },
      },
    ]);
    renderLayer();
    await act(async () => void type("orphan"));

    await waitFor(() => expect(screen.getByRole("option")).toBeTruthy());
    expect(screen.getByText("To Do")).toBeTruthy();
  });

  it("says it is searching before it says there is nothing", async () => {
    renderLayer();
    act(() => void type("zzzz"));
    expect(screen.getByText("Searching…")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("No matches")).toBeTruthy());
  });

  it("moves the selection with the arrow keys and wraps", async () => {
    projectsState.projects = [
      { _id: "p1", key: "MOB", name: "Mobile App", icon: "📱" },
      { _id: "p2", key: "MOB2", name: "Mobile App Two", icon: "📱" },
    ];
    renderLayer();
    await act(async () => void type("mobile"));
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));

    const selected = () =>
      screen.getAllByRole("option").find((o) => o.getAttribute("aria-selected") === "true")
        ?.textContent;

    expect(selected()).toContain("Mobile App");
    act(() => press("ArrowDown"));
    expect(selected()).toContain("Mobile App Two");
    act(() => press("ArrowDown"));
    expect(selected()).toContain("Mobile App");
    act(() => press("ArrowUp"));
    expect(selected()).toContain("Mobile App Two");
  });

  it("opens the selected hit on Enter and closes behind itself", async () => {
    projectsState.projects = [{ _id: "p1", key: "MOB", name: "Mobile App", icon: "📱" }];
    const { onClose } = renderLayer();
    await act(async () => void type("mobile"));
    await waitFor(() => expect(screen.getByRole("option")).toBeTruthy());

    act(() => press("Enter"));
    expect(push).toHaveBeenCalledWith("/projects/MOB");
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on Escape without navigating", async () => {
    projectsState.projects = [{ _id: "p1", key: "MOB", name: "Mobile App", icon: "📱" }];
    const { onClose } = renderLayer();
    await act(async () => void type("mobile"));

    act(() => press("Escape"));
    expect(onClose).toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("offers the full result set as a linkable page", async () => {
    renderLayer();
    await act(async () => void type("login bug"));
    expect(
      screen.getByRole("link", { name: "See all results" }).getAttribute("href")
    ).toBe("/search?q=login%20bug");
  });
});
