import { describe, it, expect } from "vitest";
import { parseGroupRoleMap } from "./group-role-map";

describe("parseGroupRoleMap (BP-862)", () => {
  it("takes groups and roles, trimmed", () => {
    expect(parseGroupRoleMap({ map: [{ group: " staff ", role: "member" }, { group: "leads", role: "owner" }] })).toEqual({
      ok: true,
      value: [{ group: "staff", role: "member" }, { group: "leads", role: "owner" }],
    });
  });

  it("takes an empty map, which unmaps the board", () => {
    expect(parseGroupRoleMap({ map: [] })).toEqual({ ok: true, value: [] });
  });

  it.each([
    ["no map", {}],
    ["a map that is not a list", { map: "staff" }],
    ["a body that is not an object", null],
    ["a blank group", { map: [{ group: "  ", role: "member" }] }],
    ["a group that is too long", { map: [{ group: "g".repeat(201), role: "member" }] }],
    ["a group with a control character", { map: [{ group: "a\nb", role: "member" }] }],
    ["a role that is not owner or member", { map: [{ group: "staff", role: "admin" }] }],
    ["a row that is not an object", { map: ["staff"] }],
    ["a group mapped twice", { map: [{ group: "staff", role: "member" }, { group: "staff", role: "owner" }] }],
    ["more than fifty rows", { map: Array.from({ length: 51 }, (_, i) => ({ group: `g${i}`, role: "member" })) }],
  ])("refuses %s", (_name, body) => {
    expect(parseGroupRoleMap(body).ok).toBe(false);
  });
});
