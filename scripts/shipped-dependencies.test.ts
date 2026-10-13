import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");

// The menu bar app and the worker tarball carry no third-party code, only the project's LICENSE
// (menubar/bundle.sh, worker/pack.sh). If one of them starts to, its notices have to travel with
// it first, and the SBOM job in release.yml has to cover it (BP-944).
describe("what the worker and the menu bar app ship", () => {
  it("has no runtime dependency in the worker", () => {
    const manifest = JSON.parse(readFileSync(join(root, "worker/package.json"), "utf8"));

    expect(manifest.dependencies ?? {}).toEqual({});
    expect(manifest.optionalDependencies ?? {}).toEqual({});
  });

  it("has no Swift package in the menu bar app", () => {
    const manifest = readFileSync(join(root, "menubar/Package.swift"), "utf8");

    expect(manifest).not.toMatch(/\.(package|binaryTarget)\s*\(/);
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

// The notices tell a reader of the image that the LGPL and the GPL it incorporates are in its
// licenses directory; sharp-libvips is LGPL-3.0-or-later and needs both (BP-944)
describe("the licence texts the notices point at", () => {
  it("has the GNU LGPL v3 and GPL v3 in the repository", () => {
    expect(readFileSync(join(root, "licenses/LGPL-3.0.txt"), "utf8")).toMatch(/^\s*GNU LESSER GENERAL PUBLIC LICENSE\s+Version 3/);
    expect(readFileSync(join(root, "licenses/GPL-3.0.txt"), "utf8")).toMatch(/^\s*GNU GENERAL PUBLIC LICENSE\s+Version 3/);
  });

  it("puts them in the image", () => {
    expect(readFileSync(join(root, "Dockerfile"), "utf8")).toContain("COPY --from=builder /app/licenses ./licenses");
    expect(readFileSync(join(root, ".dockerignore"), "utf8")).not.toMatch(/(^|\/)licenses\b/m);
  });
});
