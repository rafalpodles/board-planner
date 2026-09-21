import { describe, it, expect } from "vitest";
import { machineMayNotForce } from "@/lib/force-guard";

describe("machineMayNotForce", () => {
  it("refuses a machine credential that sends force", () => {
    expect(machineMayNotForce({ viaMachineCredential: true }, true)).toBe(true);
  });

  it("lets a person's session force", () => {
    expect(machineMayNotForce({ viaMachineCredential: false }, true)).toBe(false);
    expect(machineMayNotForce({}, true)).toBe(false);
  });

  it("has nothing to refuse when force is not exactly true", () => {
    for (const force of [undefined, false, "true", 1, null]) {
      expect(machineMayNotForce({ viaMachineCredential: true }, force)).toBe(false);
    }
  });
});
