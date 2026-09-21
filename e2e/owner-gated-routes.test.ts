import { describe, expect, it } from "vitest";
import { ownerGatedMethods, scanOwnerGatedRoutes } from "./owner-gated-routes";

describe("the owner-gated route scan", () => {
  it("finds the routes, including the one BP-563 already drove", () => {
    const keys = scanOwnerGatedRoutes().map((r) => r.key);
    expect(keys.length).toBeGreaterThanOrEqual(20);
    expect(keys).toContain("GET /api/projects/[projectId]/members");
    expect(keys).toContain("DELETE /api/projects/[projectId]/custom-fields/[fieldId]");
  });

  it("reads every method a file exports through the gate, and nothing it does not", () => {
    const source = [
      'import { withProjectAccess, withProjectOwner } from "@/lib/middleware";',
      "export const GET = withProjectAccess(async () => ok);",
      "export const PUT = withProjectOwner(async () => ok);",
      "export const DELETE = withProjectOwner(async () => ok);",
    ].join("\n");
    expect(ownerGatedMethods(source).methods).toEqual(["PUT", "DELETE"]);
  });

  it("counts only the wrapper itself, not one whose name merely starts the same", () => {
    const source = "export const GET = withProjectOwnerAndWorker(async () => ok);";
    expect(ownerGatedMethods(source)).toEqual({ methods: [], unread: 0 });
  });

  it("refuses the wrapper imported under another name", () => {
    const source = [
      'import { withProjectOwner as ownerOnly } from "@/lib/middleware";',
      "export const GET = ownerOnly(async () => ok);",
    ].join("\n");
    expect(ownerGatedMethods(source).unread).toBe(1);
  });

  it("refuses a shape it cannot read rather than skipping it", () => {
    expect(ownerGatedMethods("export const GET = withAuth(withProjectOwner(handler));").unread).toBe(1);
    expect(
      ownerGatedMethods("const handler = withProjectOwner(fn);\nexport { handler as POST };").unread
    ).toBe(1);
  });
});
