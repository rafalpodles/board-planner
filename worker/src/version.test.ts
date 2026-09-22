import { describe, expect, it } from "vitest";
import { UNKNOWN_VERSION, workerVersion } from "./version.js";

function files(entries: Record<string, string>) {
  return (path: string) => entries[path] ?? null;
}

describe("workerVersion", () => {
  it("reads the version stamped beside main.js, as the app bundle ships it", () => {
    const read = files({
      "/App/Resources/worker/package.json": JSON.stringify({ type: "module", version: "1.2.3" }),
    });

    expect(workerVersion(read, "/App/Resources/worker")).toBe("1.2.3");
  });

  it("falls back to the package.json next to dist/, as the tarball ships it", () => {
    const read = files({
      "/opt/worker/package.json": JSON.stringify({ name: "board-planner-worker", version: "1.1.1" }),
    });

    expect(workerVersion(read, "/opt/worker/dist")).toBe("1.1.1");
  });

  it("skips a package.json that carries no version for one that does", () => {
    const read = files({
      "/opt/worker/dist/package.json": JSON.stringify({ type: "module" }),
      "/opt/worker/package.json": JSON.stringify({ version: "2.0.0" }),
    });

    expect(workerVersion(read, "/opt/worker/dist")).toBe("2.0.0");
  });

  it("says it does not know rather than inventing a release", () => {
    expect(workerVersion(files({}), "/nowhere/dist")).toBe(UNKNOWN_VERSION);
    expect(
      workerVersion(files({ "/x/package.json": "not json", "/package.json": '{"version":"banana"}' }), "/x")
    ).toBe(UNKNOWN_VERSION);
  });
});
