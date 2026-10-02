import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ MIN_PASSWORD_LENGTH: 8 }));

const { checkNewAccount } = await import("./new-account");

const VALID = { username: " Ada ", fullName: " Ada Lovelace ", password: "long-enough", email: " Ada@Example.com " };

describe("checking a new account's fields", () => {
  it("normalises what will be stored", () => {
    expect(checkNewAccount(VALID)).toEqual({
      ok: true,
      value: { username: "ada", fullName: "Ada Lovelace", password: "long-enough", email: "ada@example.com" },
    });
  });

  it("leaves the address empty when none is given", () => {
    const checked = checkNewAccount({ ...VALID, email: undefined });

    expect(checked.ok && checked.value.email).toBe("");
  });

  it.each([
    ["a missing username", { ...VALID, username: "" }, "username, password, and fullName are required"],
    ["a missing password", { ...VALID, password: "" }, "username, password, and fullName are required"],
    ["a reserved username", { ...VALID, username: "pm" }, "That username is reserved"],
    ["a name of only spaces", { ...VALID, fullName: "   " }, undefined],
    ["an address that is not a string", { ...VALID, email: 42 }, "Invalid email"],
    ["an address that is not one", { ...VALID, email: "not-an-address" }, "That does not look like an email address"],
    ["a short password", { ...VALID, password: "short" }, "Password must be at least 8 characters"],
    ["a password that is not a string", { ...VALID, password: 12345678 }, "Password must be at least 8 characters"],
  ])("refuses %s", (_label, body, error) => {
    const checked = checkNewAccount(body);

    expect(checked.ok).toBe(false);
    if (error && !checked.ok) expect(checked.error).toBe(error);
  });
});
