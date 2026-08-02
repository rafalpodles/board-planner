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
      onOpenImport={() => {}}
      onOpenExport={() => {}}
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

  it("shows Settings only to admins", () => {
    renderTree();
    expect(screen.getByText("Settings")).toBeTruthy();

    cleanup();
    renderTree({ isAdmin: false });
    expect(screen.queryByText("Settings")).toBeNull();
  });

  it("offers New project only to admins", () => {
    renderTree();
    expect(screen.getByLabelText("New project")).toBeTruthy();

    cleanup();
    renderTree({ isAdmin: false });
    expect(screen.queryByLabelText("New project")).toBeNull();
  });

  it("triggers the import and export dialogs for the current project", async () => {
    const onOpenImport = vi.fn();
    const onOpenExport = vi.fn();
    renderTree({ onOpenImport, onOpenExport });

    await act(async () => {
      screen.getByText("Import").click();
    });
    await act(async () => {
      screen.getByText("Export").click();
    });

    expect(onOpenImport).toHaveBeenCalledTimes(1);
    expect(onOpenExport).toHaveBeenCalledTimes(1);
  });

  // Import/export act on whatever project the board is showing, so they make no
  // sense under a project you have merely expanded to peek at
  it("does not offer import or export under a non-route project", async () => {
    renderTree();
    await act(async () => {
      screen.getByLabelText("Expand Mobile App").click();
    });
    expect(screen.queryByText("Import")).toBeNull();
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
  function rows(container: HTMLElement) {
    return [...container.querySelectorAll('[draggable="true"]')] as HTMLElement[];
  }

  function drag(container: HTMLElement, fromIndex: number, toIndex: number) {
    const data = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "",
      dropEffect: "",
      setData: (k: string, v: string) => void data.set(k, v),
      getData: (k: string) => data.get(k) ?? "",
    };
    const source = rows(container)[fromIndex];
    const target = rows(container)[toIndex];

    const fire = (el: HTMLElement, type: string) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
      el.dispatchEvent(event);
    };

    fire(source, "dragstart");
    fire(target, "dragover");
    fire(target, "drop");
  }

  it("makes rows draggable when reordering is allowed", () => {
    const { container } = renderTree({ onReorder: () => {} });
    expect(rows(container)).toHaveLength(2);
  });

  it("makes nothing draggable without a reorder handler", () => {
    const { container } = renderTree();
    expect(rows(container)).toHaveLength(0);
  });

  // One project cannot be reordered against anything
  it("makes nothing draggable with a single project", () => {
    const { container } = renderTree({
      projects: [project({ _id: "1", key: "TP" })],
      onReorder: () => {},
    });
    expect(rows(container)).toHaveLength(0);
  });

  it("reports the reordered ids on drop", async () => {
    const onReorder = vi.fn();
    const { container } = renderTree({ onReorder });
    await act(async () => drag(container, 0, 1));
    expect(onReorder).toHaveBeenCalledWith(["2", "1"]);
  });

  it("reports nothing when a row is dropped on itself", async () => {
    const onReorder = vi.fn();
    const { container } = renderTree({ onReorder });
    await act(async () => drag(container, 1, 1));
    expect(onReorder).not.toHaveBeenCalled();
  });
});
