import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import path from "path";

// BP-766. Next inlines process.env.NEXT_PUBLIC_* when it builds, and the published image is built
// once for every self-hoster, so a value read that way is the build machine's, never the instance's
const SRC = path.resolve(__dirname, "..");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe("values baked in at build time", () => {
  it("finds the source files it scans", () => {
    expect(sources(SRC).length).toBeGreaterThan(100);
  });

  it("are read nowhere in the app", () => {
    const readers = sources(SRC).filter((file) =>
      /process\.env\.NEXT_PUBLIC_|process\.env\[\s*["'`]NEXT_PUBLIC_/.test(readFileSync(file, "utf8"))
    );

    expect(readers.map((file) => path.relative(SRC, file))).toEqual([]);
  });
});
