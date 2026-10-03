import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectionsMissingFromSnapshot } from "./tenant-migration";

describe("collectionsMissingFromSnapshot", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bp662-snapshot-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("names every collection that has no file in the snapshot", () => {
    writeFileSync(join(dir, "users.json"), "[]");
    writeFileSync(join(dir, "tasks.json"), "[]");

    expect(collectionsMissingFromSnapshot(dir, ["users", "tasks", "projects", "sessions"])).toEqual([
      "projects",
      "sessions",
    ]);
  });

  it("is empty only when the snapshot covers everything", () => {
    writeFileSync(join(dir, "users.json"), "[]");

    expect(collectionsMissingFromSnapshot(dir, ["users"])).toEqual([]);
  });

  it("treats a missing directory as a snapshot of nothing", () => {
    expect(collectionsMissingFromSnapshot(join(dir, "absent"), ["users"])).toEqual(["users"]);
  });
});
