import { describe, it, expect } from "vitest";
import { displayNameOf, namesOf } from "./usernames";
import type { ScopedDb } from "@/lib/db-scope";

const dbWith = (user: Record<string, unknown> | null) =>
  ({ User: { findById: () => ({ lean: async () => user }) } }) as unknown as ScopedDb;

describe("namesOf", () => {
  it("names a person by their full name and keeps their handle beside it", async () => {
    expect(await namesOf(dbWith({ username: "ann", fullName: "Ann Lee" }), "u1")).toEqual({
      username: "ann",
      displayName: "Ann Lee",
    });
  });

  it("marks the PM as an AI by the name it has, not by its handle", async () => {
    expect(await displayNameOf(dbWith({ username: "pm", fullName: "PM Agent" }), "u1")).toBe("PM Agent (AI)");
  });

  it("falls back to the handle when the name is blank, and to somebody when the person is gone", async () => {
    expect(await displayNameOf(dbWith({ username: "ann", fullName: "  " }), "u1")).toBe("ann");
    expect(await namesOf(dbWith(null), "u1")).toEqual({ username: "somebody", displayName: "somebody" });
  });
});
