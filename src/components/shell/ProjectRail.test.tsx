// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { ProjectRail } from "./ProjectRail";
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

const TP = project({ _id: "1", key: "TP", name: "Test Project", icon: "🚀" });
const MOB = project({ _id: "2", key: "MOB", name: "Mobile App", icon: "📱" });

function renderRail(pathname: string, projects: ApiProject[] = [TP, MOB]) {
  return render(<ProjectRail projects={projects} pathname={pathname} />);
}

afterEach(cleanup);

describe("ProjectRail", () => {
  it("links every project by its name, so another project is one click away", () => {
    renderRail("/projects");
    expect(screen.getByLabelText("Test Project").getAttribute("href")).toBe("/projects/TP");
    expect(screen.getByLabelText("Mobile App").getAttribute("href")).toBe("/projects/MOB");
  });

  it("keeps the way to the projects list", () => {
    renderRail("/projects");
    const all = screen.getByLabelText("All projects");
    expect(all.getAttribute("href")).toBe("/projects");
    expect(all.getAttribute("aria-current")).toBe("page");
  });

  it("marks All projects as current only when no project owns the route", () => {
    renderRail("/projects/TP/sprints");
    expect(screen.getByLabelText("All projects").getAttribute("aria-current")).toBeNull();
  });

  it("opens the sections of the project the route is on, and no other project's", () => {
    renderRail("/projects/TP/sprints");
    const sections = screen.getByRole("group", { name: "Test Project sections" });
    expect(within(sections).getByLabelText("Board").getAttribute("href")).toBe("/projects/TP");
    expect(within(sections).getByLabelText("Sprints").getAttribute("href")).toBe(
      "/projects/TP/sprints",
    );
    expect(within(sections).getByLabelText("Dashboard")).toBeTruthy();
    expect(within(sections).getByLabelText("PM agent")).toBeTruthy();
    expect(within(sections).getByLabelText("Settings")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Mobile App sections" })).toBeNull();
    expect(screen.getAllByLabelText("Board").length).toBe(1);
  });

  it("marks the current section and only that one", () => {
    renderRail("/projects/TP/sprints");
    const sections = screen.getByRole("group", { name: "Test Project sections" });
    const current = within(sections)
      .getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "page");
    expect(current.map((link) => link.getAttribute("aria-label"))).toEqual(["Sprints"]);
  });

  it("marks Board on the board itself, including a task opened over it", () => {
    renderRail("/projects/TP");
    const sections = screen.getByRole("group", { name: "Test Project sections" });
    expect(within(sections).getByLabelText("Board").getAttribute("aria-current")).toBe("page");
  });

  it("accents exactly the project the route is on", () => {
    const { container } = renderRail("/projects/MOB/dashboard");
    const accented = container.querySelectorAll("[data-active-project]");
    expect(accented.length).toBe(1);
    expect(accented[0].getAttribute("aria-label")).toBe("Mobile App");
  });

  it("opens no sections on the projects list", () => {
    renderRail("/projects");
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("leaves out the PM agent where the instance has locked it", () => {
    renderRail("/projects/TP", [
      project({ _id: "1", key: "TP", name: "Test Project", pm: { lockedByInstance: true } } as never),
    ]);
    expect(screen.queryByLabelText("PM agent")).toBeNull();
    expect(screen.getByLabelText("Settings")).toBeTruthy();
  });

  it("shows that a project has a running sprint", () => {
    const { container } = renderRail("/projects/TP", [
      project({ _id: "1", key: "TP", name: "Test Project", hasActiveSprint: true }),
    ]);
    const sprints = screen.getByLabelText("Sprints");
    expect(sprints.querySelector(".bg-success")).toBeTruthy();
    expect(container.querySelectorAll(".bg-success").length).toBe(1);
  });
});
