// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { matchProjects, toHits, SidebarSearchResults, SearchHit } from "./SidebarSearch";
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
});

describe("SidebarSearchResults", () => {
  const hits: SearchHit[] = [
    { id: "a", kind: "project", href: "/projects/TP", label: "Test Project", meta: "TP" },
    { id: "b", kind: "task", href: "/projects/TP/tasks/42", label: "Fix login", meta: "TP-42" },
  ];

  function renderResults(over: Partial<React.ComponentProps<typeof SidebarSearchResults>> = {}) {
    const onOpen = vi.fn();
    const utils = render(
      <SidebarSearchResults
        hits={hits}
        loading={false}
        selectedIndex={0}
        onHover={() => {}}
        onOpen={onOpen}
        {...over}
      />
    );
    return { ...utils, onOpen };
  }

  it("renders one option per hit", () => {
    renderResults();
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("marks exactly the selected option", () => {
    renderResults({ selectedIndex: 1 });
    const selected = screen.getAllByRole("option").filter(
      (o) => o.getAttribute("aria-selected") === "true"
    );
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toContain("Fix login");
  });

  it("opens the hit that was clicked", async () => {
    const { onOpen } = renderResults();
    await act(async () => screen.getByText("Fix login").closest("button")!.click());
    expect(onOpen).toHaveBeenCalledWith(hits[1]);
  });

  it("says it is searching before it says there is nothing", () => {
    renderResults({ hits: [], loading: true });
    expect(screen.getByText("Searching…")).toBeTruthy();

    cleanup();
    renderResults({ hits: [], loading: false });
    expect(screen.getByText("No matches")).toBeTruthy();
  });
});
