import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");

// The menu bar app and the worker tarball carry the project's LICENSE and nothing else
// (menubar/bundle.sh, worker/pack.sh). If one of them starts to ship third-party code, its notices
// have to travel with it first, and the SBOM job in release.yml has to cover it (BP-944).
describe("what the worker and the menu bar app ship", () => {
  it("has no runtime dependency in the worker", () => {
    const manifest = JSON.parse(readFileSync(join(root, "worker/package.json"), "utf8"));

    expect(manifest.dependencies ?? {}).toEqual({});
    expect(manifest.optionalDependencies ?? {}).toEqual({});
  });

  it("has no Swift package in the menu bar app", () => {
    const manifest = readFileSync(join(root, "menubar/Package.swift"), "utf8");

    expect(manifest).not.toMatch(/\.package\s*\(/);
  });

  it("carries the licence in the menu bar bundle", () => {
    expect(readFileSync(join(root, "menubar/bundle.sh"), "utf8")).toContain(
      'cp "$ROOT/../LICENSE" "$APP/Contents/Resources/LICENSE"'
    );
  });

  it("carries the licence in the worker tarball", () => {
    expect(readFileSync(join(root, "worker/pack.sh"), "utf8")).toContain('cp "$ROOT/../LICENSE"');
  });
});
