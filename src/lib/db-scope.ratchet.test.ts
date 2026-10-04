import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import allowed from "./db-scope.ratchet.json";

const SRC = join(__dirname, "..");
const ROOT = join(SRC, "..");

const UNSCOPED = ["tenant", "rateLimit"];
const MODEL_IMPORT = /^\s*import\s+(?!type\b)[^;]*?from\s+["'](?:@\/models\/|(?:\.\.?\/)+models\/)([A-Za-z]+)["']/gm;
const RAW_ACCESS = /mongoose\.models?\b|mongoose\.connection\.db|\bconnection\.db\b/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === "models" ? [] : sources(path);
    return /\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry) ? [path] : [];
  });
}

function reachesTheDatabaseRaw(path: string): boolean {
  const text = readFileSync(path, "utf8");
  const imports = [...text.matchAll(MODEL_IMPORT)].map((match) => match[1]);
  return imports.some((name) => !UNSCOPED.includes(name)) || RAW_ACCESS.test(text);
}

const raw = sources(SRC)
  .filter((path) => relative(SRC, path) !== join("lib", "db-scope.ts"))
  .filter(reachesTheDatabaseRaw)
  .map((path) => relative(ROOT, path))
  .sort();

describe("the ratchet on raw database access (BP-663)", () => {
  it("lets no new file reach a model or the database without the tenant-scoped accessor", () => {
    const fresh = raw.filter((path) => !allowed.includes(path));
    expect(
      fresh,
      "These files import a tenant-scoped model or reach mongoose directly. Use `db` from the handler's context (src/lib/db-scope.ts) instead of adding to src/lib/db-scope.ratchet.json."
    ).toEqual([]);
  });

  it("lists only files that still do, so the list can only shrink", () => {
    const stale = allowed.filter((path) => !raw.includes(path));
    expect(
      stale,
      "These files no longer reach the database raw. Remove them from src/lib/db-scope.ratchet.json."
    ).toEqual([]);
  });

  it("is sorted and free of duplicates", () => {
    expect(allowed).toEqual([...new Set(allowed)].sort());
  });
});
