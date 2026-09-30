import { describe, expect, it } from "vitest";
import {
  inlineOwnerChecks,
  ownerGatedMethods,
  scanInlineOwnerChecks,
  scanOwnerGatedRoutes,
  withoutComments,
} from "./owner-gated-routes";

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

describe("the inline owner-check scan", () => {
  const methodsOf = (source: string) => inlineOwnerChecks(source).sites.map((s) => s.method);

  it("finds the four routes BP-748 named", () => {
    const keys = scanInlineOwnerChecks().map((c) => c.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        "PUT /api/projects/[projectId]/agent",
        "PATCH /api/projects/[projectId]/custom-fields/[fieldId]",
        "POST /api/agents",
        "PUT /api/agents/[agentId]",
        "DELETE /api/agents/[agentId]",
      ])
    );
  });

  it("attributes a check to the exported method it sits in, and skips the access checks", () => {
    const source = [
      "export const GET = withProjectAccess(async (_r, { user }) => {",
      '  if (!(await check(user, projectId, "access"))) return no;',
      "});",
      "export const PUT = withProjectAccess(async (_r, { user }) => {",
      '  if (!(await check(user, String(project._id), "admin"))) return no;',
      "});",
      "export async function POST(request: Request) {",
      "  const ids = await administeredProjectIds(user, projects.map((p) => String(p._id)));",
      "}",
    ].join("\n");
    expect(inlineOwnerChecks(source)).toEqual({
      sites: [
        { method: "PUT", line: 5 },
        { method: "POST", line: 8 },
      ],
      unread: [],
    });
  });

  it("reads a need split across lines, with a trailing comma", () => {
    const source = [
      "export const POST = withAuth(async () => {",
      "  const may = await check(",
      "    user,",
      "    projectId,",
      '    "admin",',
      "  );",
      "});",
    ].join("\n");
    expect(methodsOf(source)).toEqual(["POST"]);
  });

  it("follows a module-level helper to every exported method that calls it", () => {
    const source = [
      "async function mayEdit(user, agent) {",
      '  return check(user, String(agent.project), "admin");',
      "}",
      "export const PUT = withAuth(async () => { if (!(await mayEdit(user, agent))) return no; });",
      "export const GET = withAuth(async () => ok);",
      "export const DELETE = withAuth(async () => { if (!(await mayEdit(user, agent))) return no; });",
    ].join("\n");
    expect(methodsOf(source)).toEqual(["PUT", "DELETE"]);
  });

  it("refuses a helper no exported method calls, rather than dropping the check", () => {
    const source = [
      "export const GET = withAuth(async () => ok);",
      'const mayAdmin = (user) => check(user, projectId, "admin");',
      "export { mayAdmin };",
    ].join("\n");
    expect(inlineOwnerChecks(source)).toMatchObject({ sites: [], unread: [expect.stringMatching(/mayAdmin/)] });
  });

  it("refuses a need it cannot read, and a grant check under another name", () => {
    expect(inlineOwnerChecks("export const GET = withAuth(async () => check(user, id, need));").unread).toEqual([
      expect.stringMatching(/cannot read \(need\)/),
    ]);
    expect(inlineOwnerChecks('import { check as can } from "@/lib/grants";').unread).toHaveLength(1);
  });

  it("does not count a method call, or a name that merely ends the same", () => {
    const source = [
      'export const GET = withAuth(async () => { await limiter.check(user, id, "admin"); });',
      'export const PUT = withAuth(async () => { await spotcheck(user, id, "admin"); });',
    ].join("\n");
    expect(inlineOwnerChecks(source)).toEqual({ sites: [], unread: [] });
  });

  it("does not count a check that is commented out, whichever way", () => {
    const source = [
      "export const PUT = withProjectAccess(async () => {",
      '  // if (!(await check(user, projectId, "admin"))) return no;',
      '  /* const may = await check(user, projectId, "admin"); */',
      "  /**",
      '   * administeredProjectIds(user, ids) was here',
      "   */",
      "  return ok;",
      "});",
    ].join("\n");
    expect(inlineOwnerChecks(source)).toEqual({ sites: [], unread: [] });
  });

  it("still counts a check that follows something shaped like a comment inside a string", () => {
    const source = [
      "export const GET = withAuth(async () => {",
      '  const url = "https://example.com/*";',
      "  const note = `see ${base}//docs and /* this */`;",
      '  const may = await check(user, projectId, "admin");',
      "});",
    ].join("\n");
    expect(inlineOwnerChecks(source).sites).toEqual([{ method: "GET", line: 4 }]);
  });

  it("blanks comments without moving anything", () => {
    const source = 'a // b\n/* c\nd */ e "//f" `/*${g /* h */}*/`';
    const stripped = withoutComments(source);
    expect(stripped).toHaveLength(source.length);
    expect(stripped.split("\n").length).toBe(source.split("\n").length);
    expect(stripped).toBe('a     \n    \n     e "//f" `/*${g        }*/`');
  });
});
