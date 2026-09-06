import { describe, it, expect } from "vitest";
import { duplicateKeyField } from "./mongo-errors";

describe("duplicateKeyField", () => {
  it("names the index that collided", () => {
    const err = Object.assign(new Error("E11000"), {
      code: 11000,
      keyPattern: { email: 1 },
      keyValue: { email: "taken@example.com" },
    });

    expect(duplicateKeyField(err)).toBe("email");
  });

  it("falls back to keyValue when the driver sends no pattern", () => {
    const err = Object.assign(new Error("E11000"), {
      code: 11000,
      keyValue: { username: "taken" },
    });

    expect(duplicateKeyField(err)).toBe("username");
  });

  it("still reports a collision it cannot name", () => {
    const err = Object.assign(new Error("E11000"), { code: 11000 });

    expect(duplicateKeyField(err)).toBe("unknown");
    expect(duplicateKeyField(err)).toBeTruthy();
  });

  it("says nothing about errors that are not collisions", () => {
    expect(duplicateKeyField(new Error("connection reset"))).toBeNull();
    expect(duplicateKeyField(Object.assign(new Error("x"), { code: 121 }))).toBeNull();
    expect(duplicateKeyField(null)).toBeNull();
    expect(duplicateKeyField(undefined)).toBeNull();
    expect(duplicateKeyField("E11000")).toBeNull();
  });
});
