// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { ProjectTree } from "./ProjectTree";
import { ApiProject } from "@/types";

function project(over: Partial<ApiProject> & { _id: string; key: string }): ApiProject {
  return {
    name: `Project ${over.key}`,
    icon: "📋",
    taskCount: 0,
    hasActiveSprint: false,
    ...over,
  } as ApiProject;
}

const TP = project({ _id: "1", key: "TP", name: "Test Project", taskCount: 9 });
const MOB = project({ _id: "2", key: "MOB", name: "Mobile App" });

function renderTree(over: Partial<React.ComponentProps<typeof ProjectTree>> = {}) {
  return render(
    <ProjectTree
      projects={[TP, MOB]}
      pathname="/projects/TP"
      isAdmin
      {...over}
    />
  );
}

afterEach(cleanup);

describe("ProjectTree", () => {
  it("lists every project with its name and key", () => {
    renderTree();
    expect(screen.getByText("Test Project")).toBeTruthy();
    expect(screen.getByText("TP")).toBeTruthy();
    expect(screen.getByText("Mobile App")).toBeTruthy();
    expect(screen.getByText("MOB")).toBeTruthy();
  });

  it("truncates a long project name rather than letting it push the key out", () => {
    renderTree({
      projects: [project({ _id: "3", key: "LONG", name: "A ridiculously long project name" })],
    });
    const name = screen.getByText("A ridiculously long project name");
    expect(name.className).toContain("truncate");
    expect(name.className).toContain("min-w-0");
  });

  it("accents exactly the project the route is on", () => {
    const { container } = renderTree({ pathname: "/projects/TP/tasks/1" });
    const accented = container.querySelectorAll("[data-active-project]");
    expect(accented.length).toBe(1);
    expect(accented[0].textContent).toContain("Test Project");
    expect(accented[0].className).toContain("shadow-[inset_3px_0_0_var(--color-primary)]");
  });

  it("expands the route project's sub-nav and leaves the others collapsed", () => {
    renderTree();
    expect(screen.getByText("Board")).toBeTruthy();
    expect(screen.getByText("Dashboard")).toBeTruthy();
    // Only one sub-nav is open, so each entry appears exactly once
    expect(screen.getAllByText("Board").length).toBe(1);
  });

  it("expanding another project collapses the previous one", async () => {
    renderTree();
    expect(screen.getAllByText("Board").length).toBe(1);

    await act(async () => {
      screen.getByLabelText("Expand Mobile App").click();
    });

    expect(screen.getAllByText("Board").length).toBe(1);
    expect(screen.getByLabelText("Expand Test Project")).toBeTruthy();
  });

  it("shows the task count as a pill on Board", () => {
    renderTree();
    expect(screen.getByText("9")).toBeTruthy();
  });

  it("carries no Claude activity line in an expanded project", () => {
    const { container } = renderTree();
    expect(screen.queryByText("Claude working")).toBeNull();
    expect(screen.queryByText("Claude idle")).toBeNull();
    expect(container.querySelector(".bg-success")).toBeNull();
  });

  // The activity dot and the active-sprint dot looked alike; only the former went
  it("still marks a project with an active sprint", () => {
    const { container } = renderTree({
      projects: [project({ _id: "1", key: "TP", hasActiveSprint: true })],
    });
    expect(container.querySelector(".bg-success")).toBeTruthy();
  });

  it("hides PM agent when the instance holds the lock", () => {
    renderTree({
      projects: [
        project({
          _id: "1",
          key: "TP",
          pm: { enabled: true, lockedByInstance: true },
        } as Partial<ApiProject> & { _id: string; key: string }),
      ],
    });
    expect(screen.queryByText("PM agent")).toBeNull();
  });

  it("shows PM agent when the project is not locked", () => {
    renderTree({
      projects: [
        project({
          _id: "1",
          key: "TP",
          pm: { enabled: true, lockedByInstance: false },
        } as Partial<ApiProject> & { _id: string; key: string }),
      ],
    });
    expect(screen.getByText("PM agent")).toBeTruthy();
  });

  /**
   * Until BP-371 this link was admin-only, and rightly: the page held nothing else. It now holds
   * each member's own notification settings for the board — `access: "member"` — so hiding the
   * only route to them would have left the feature reachable by typed URL alone. The page decides
   * what each person may open, and tells a non-admin in as many words that the rest needs access;
   * the sub-nav no longer decides it a second time.
   */
  it("shows Settings to everyone, because everyone has something on that page", () => {
    renderTree();
    expect(screen.getByText("Settings")).toBeTruthy();

    cleanup();
    renderTree({ isAdmin: false });
    expect(screen.getByText("Settings")).toBeTruthy();
  });

  it("shows Settings to a project admin who is not an instance admin", () => {
    renderTree({
      isAdmin: false,
      projects: [project({ _id: "1", key: "TP", canAdmin: true })],
    });
    expect(screen.getByText("Settings")).toBeTruthy();
  });

  it("shows Settings to a member of a project they cannot administer", () => {
    renderTree({
      isAdmin: false,
      projects: [project({ _id: "1", key: "TP", canAdmin: false })],
    });
    expect(screen.getByText("Settings")).toBeTruthy();
  });

  it("still keeps New project to instance admins even for a project admin", () => {
    renderTree({
      isAdmin: false,
      projects: [project({ _id: "1", key: "TP", canAdmin: true })],
    });
    expect(screen.queryByLabelText("New project")).toBeNull();
  });

  it("offers New project only to admins", () => {
    renderTree();
    expect(screen.getByLabelText("New project")).toBeTruthy();

    cleanup();
    renderTree({ isAdmin: false });
    expect(screen.queryByLabelText("New project")).toBeNull();
  });

  // Import/export was deleted in CP-205; the sub-nav is links only now
  it("offers no import or export entry", async () => {
    renderTree();
    expect(screen.queryByText("Import")).toBeNull();
    expect(screen.queryByText("Export")).toBeNull();
  });

  it("renders every sub-nav entry as a link, never a button", async () => {
    const { container } = renderTree();
    const subNav = [...container.querySelectorAll("a, button")].filter((el) =>
      ["Board", "Sprints", "Dashboard", "PM agent", "Settings"].includes(el.textContent?.trim() || "")
    );
    expect(subNav.length).toBeGreaterThan(0);
    expect(subNav.every((el) => el.tagName === "A")).toBe(true);
  });

  it("links sub-nav entries under the project key", () => {
    renderTree();
    expect(screen.getByText("Sprints").closest("a")?.getAttribute("href")).toBe(
      "/projects/TP/sprints"
    );
    expect(screen.getByText("Dashboard").closest("a")?.getAttribute("href")).toBe(
      "/projects/TP/dashboard"
    );
  });
});

describe("ProjectTree reordering", () => {
  // The drag itself belongs to dnd-kit and needs real pointer geometry, which this
  // environment cannot provide; the order a drop produces is covered in reorder.test
  function sortableRows(container: HTMLElement) {
    return [...container.querySelectorAll('[aria-roledescription="sortable"]')];
  }

  it("makes rows sortable when reordering is allowed", () => {
    const { container } = renderTree({ onReorder: () => {} });
    expect(sortableRows(container)).toHaveLength(2);
  });

  it("makes nothing sortable without a reorder handler", () => {
    const { container } = renderTree();
    expect(sortableRows(container)).toHaveLength(0);
  });

  // One project cannot be reordered against anything
  it("makes nothing sortable with a single project", () => {
    const { container } = renderTree({
      projects: [project({ _id: "1", key: "TP" })],
      onReorder: () => {},
    });
    expect(sortableRows(container)).toHaveLength(0);
  });
});
