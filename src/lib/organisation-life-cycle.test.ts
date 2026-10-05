import { describe, it, expect } from "vitest";
import "@/models/all";
import { SCOPED_MODELS } from "./db-scope";
import { scopedModelNames } from "./organisation-migration";
import { NOT_EXPORTED } from "./organisation-life-cycle";

describe("an organisation's export and delete cover every model it has (BP-893)", () => {
  it("can reach every scoped model through the scoped db, so delete and export miss none", () => {
    expect(scopedModelNames().filter((name) => !Object.hasOwn(SCOPED_MODELS, name))).toEqual([]);
  });

  it("leaves out of the export only real models, each with a reason", () => {
    for (const [name, reason] of Object.entries(NOT_EXPORTED)) {
      expect(scopedModelNames(), name).toContain(name);
      expect(reason.length, name).toBeGreaterThan(0);
    }
  });
});
