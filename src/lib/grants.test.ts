import { describe, it, expect } from "vitest";
import { decide, Principal, principalOf } from "./grants";
import { IUser } from "@/types";

const P = "69a52e3b399b27d3cbb2c5a5";
const OTHER = "69a52e3b399b27d3cbb2c5a6";

function principal(over: Partial<Principal> = {}): Principal {
  return {
    instanceAdmin: false,
    tokenScoped: false,
    tokenScope: null,
    instanceAdminBeforeScope: false,
    ...over,
  };
}

describe("decide", () => {
  it("gives an instance admin both access and admin without any grant", () => {
    const p = principal({ instanceAdmin: true });
    expect(decide(p, null, "access", P)).toBe(true);
    expect(decide(p, null, "admin", P)).toBe(true);
  });

  it("gives an owner both access and admin", () => {
    const p = principal();
    expect(decide(p, "owner", "access", P)).toBe(true);
    expect(decide(p, "owner", "admin", P)).toBe(true);
  });

  it("gives a member access but never admin", () => {
    const p = principal();
    expect(decide(p, "member", "access", P)).toBe(true);
    expect(decide(p, "member", "admin", P)).toBe(false);
  });

  it("refuses someone with no grant at all", () => {
    const p = principal();
    expect(decide(p, null, "access", P)).toBe(false);
    expect(decide(p, null, "admin", P)).toBe(false);
  });

  it("refuses a project outside a token's scope even to an owner", () => {
    const p = principal({ tokenScoped: true, tokenScope: [OTHER] });
    expect(decide(p, "owner", "access", P)).toBe(false);
  });

  it("never lets a scoped token administer, even as owner in scope", () => {
    const p = principal({ tokenScoped: true, tokenScope: [P] });
    expect(decide(p, "owner", "admin", P)).toBe(false);
    expect(decide(p, "owner", "access", P)).toBe(true);
  });

  // The regression the spec is built around: applyTokenScope downgrades an instance admin to
  // member, and instance admins hold no grant rows, so a naive lookup strips all their access.
  it("keeps an instance admin's scoped token working inside its scope", () => {
    const p = principal({ tokenScoped: true, tokenScope: [P], instanceAdminBeforeScope: true });
    expect(decide(p, null, "access", P)).toBe(true);
    expect(decide(p, null, "admin", P)).toBe(false);
  });

  it("still confines an instance admin's scoped token to its scope", () => {
    const p = principal({ tokenScoped: true, tokenScope: [OTHER], instanceAdminBeforeScope: true });
    expect(decide(p, null, "access", P)).toBe(false);
  });
});

describe("principalOf", () => {
  it("maps a plain user to the right principal", () => {
    const user = {
      _id: "u1" as any,
      role: "member" as const,
    } as IUser;
    expect(principalOf(user)).toEqual({
      instanceAdmin: false,
      tokenScoped: false,
      tokenScope: null,
      instanceAdminBeforeScope: false,
    });
  });

  it("maps an instance admin correctly", () => {
    const user = {
      _id: "a1" as any,
      role: "admin" as const,
    } as IUser;
    const result = principalOf(user);
    expect(result.instanceAdmin).toBe(true);
  });

  it("converts tokenScope ObjectIds to strings", () => {
    const user = {
      _id: "u1" as any,
      role: "member" as const,
      tokenScoped: true,
      tokenScope: [P] as any,
      instanceAdminBeforeScope: true,
    } as IUser;
    const result = principalOf(user);
    expect(result.tokenScope).toEqual([P]);
    expect(result.tokenScoped).toBe(true);
    expect(result.instanceAdminBeforeScope).toBe(true);
  });
});
