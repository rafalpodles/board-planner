import { describe, it, expect } from "vitest";
import { Types } from "mongoose";
import { Project } from "./project";

const row = { name: "Orbit", key: "ORB", organisation: new Types.ObjectId() };

describe("Project.groupRoleMap (BP-862)", () => {
  it("is empty for a board that maps nothing, and for one older than the field", () => {
    expect(new Project(row).groupRoleMap).toHaveLength(0);
    expect(Project.hydrate(row).groupRoleMap).toHaveLength(0);
  });

  it("keeps the groups and roles it is given, on the board itself and not on its saved views", () => {
    const project = new Project({ ...row, groupRoleMap: [{ group: "staff", role: "member" }] });

    expect(project.groupRoleMap.map(({ group, role }) => ({ group, role }))).toEqual([{ group: "staff", role: "member" }]);
    expect(Project.schema.path("groupRoleMap")).toBeDefined();
    expect(Project.schema.path("savedViews")).toBeDefined();
    expect(Object.keys((Project.schema.path("savedViews") as unknown as { schema: { paths: object } }).schema.paths)).not.toContain("groupRoleMap");
  });

  it("refuses a role that is not owner or member, and a group that is too long", () => {
    const bad = new Project({ ...row, groupRoleMap: [{ group: "g".repeat(201), role: "admin" }] }).validateSync();

    expect(bad?.errors["groupRoleMap.0.role"]).toBeDefined();
    expect(bad?.errors["groupRoleMap.0.group"]).toBeDefined();
  });
});
