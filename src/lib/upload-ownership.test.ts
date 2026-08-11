import { describe, it, expect } from "vitest";
import { projectForUpload } from "./upload-ownership";

describe("projectForUpload", () => {
  it("returns the project recorded when the file was uploaded", () => {
    expect(projectForUpload({ metadata: { project: "p1" } })).toBe("p1");
  });

  it("is null when nothing was recorded, so the file cannot be read", () => {
    // Legacy files are stamped by scripts/migrate-upload-projects.ts, never resolved per request:
    // the search that recovers an owner is attacker-controlled, so it belongs offline
    expect(projectForUpload({ metadata: {} })).toBeNull();
    expect(projectForUpload({})).toBeNull();
  });

  it("is null for an empty recorded project rather than treating it as a match", () => {
    expect(projectForUpload({ metadata: { project: "" } })).toBeNull();
  });
});
