import { describe, it, expect } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const APP = join(__dirname, "..", "app");
const ROOT = join(__dirname, "..", "..");

function routes(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return routes(path);
    return entry === "route.ts" ? [relative(ROOT, path)] : [];
  });
}

describe("route shape", () => {
  it("has no route with more than two dynamic segments, which the dev server loses (BP-1042)", () => {
    const deep = routes(APP).filter((path) => (path.match(/\[[^\]/]+\]/g) ?? []).length > 2);
    expect(
      deep,
      "Turbopack's dev server answers a bare 404 for these for the life of the process. Serve the URL through a catch-all with a rewrite in next.config.ts, as src/app/api/task-leaf does."
    ).toEqual([]);
  });

  it("serves every rewritten URL from a catch-all route that exists", async () => {
    const config = (await import("../../next.config")).default;
    const rewrites = (await config.rewrites?.()) as { source: string; destination: string }[];
    const known = new Set(routes(APP).map((path) => path.replace(/^src\/app/, "").replace(/\/route\.ts$/, "")));
    for (const { destination } of rewrites) {
      const prefix = destination.replace(/\/:[A-Za-z]+/g, "");
      expect([...known].some((route) => route === `${prefix}/[...ids]`), destination).toBe(true);
    }
  });
});
