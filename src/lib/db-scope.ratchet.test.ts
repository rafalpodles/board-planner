import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import allowed from "./db-scope.ratchet.json";
import crossingAllowed from "./organisation-wall.crossings.json";

const SRC = join(__dirname, "..");
const ROOT = join(SRC, "..");

const UNSCOPED = ["organisation", "rateLimit", "platformAuditLog"];
const MODELS_PATH = String.raw`["'](?:@\/models\/|(?:\.\.?\/)+models\/)([A-Za-z]+)["']`;
const MODEL_IMPORT = new RegExp(
  String.raw`^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+${MODELS_PATH}|(?:import|require)\s*\(\s*${MODELS_PATH}|^\s*import\s+${MODELS_PATH}`,
  "gm"
);
const RAW_ACCESS =
  /\bmongoose\.(?:models?|connections?)\b|\bconnection\.(?:db|collection|getClient)\b|import\s+(?:\w+\s*,\s*)?\{[^}]*\b(?:model|models|connection)\b[^}]*\}\s*from\s*["']mongoose["']|import\s*\*\s*as\s+\w+\s+from\s*["']mongoose["']/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return path === join(SRC, "models") ? [] : sources(path);
    return /\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry) ? [path] : [];
  });
}

function reachesTheDatabaseRaw(path: string): boolean {
  const text = readFileSync(path, "utf8");
  const imports = [...text.matchAll(MODEL_IMPORT)].map((match) => match[1] ?? match[2] ?? match[3]);
  return imports.some((name) => !UNSCOPED.includes(name)) || RAW_ACCESS.test(text);
}

const raw = sources(SRC)
  .filter((path) => relative(SRC, path) !== join("lib", "db-scope.ts"))
  .filter(reachesTheDatabaseRaw)
  .map((path) => relative(ROOT, path))
  .sort();

describe("the ratchet on raw database access (BP-663)", () => {
  it("lets no new file reach a model or the database without the organisation-scoped accessor", () => {
    const fresh = raw.filter((path) => !allowed.includes(path));
    expect(
      fresh,
      "These files import an organisation-scoped model or reach mongoose directly. Use `db` from the handler's context (src/lib/db-scope.ts) instead of adding to src/lib/db-scope.ratchet.json."
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

const CROSSING = /\bacrossOrganisations\b/;
const crossing = sources(SRC)
  .filter((path) => relative(SRC, path) !== join("lib", "organisation-wall.ts"))
  .filter((path) => CROSSING.test(readFileSync(path, "utf8")))
  .map((path) => relative(ROOT, path))
  .sort();

describe("the ratchet on queries that cross organisations (BP-890)", () => {
  it("lets no new file step around the organisation wall", () => {
    expect(
      crossing.filter((path) => !crossingAllowed.includes(path)),
      "These files call acrossOrganisations. Name the organisation in the filter instead of adding to src/lib/organisation-wall.crossings.json."
    ).toEqual([]);
  });

  it("lists only files that still do, so the list can only shrink", () => {
    expect(crossingAllowed.filter((path) => !crossing.includes(path))).toEqual([]);
  });
});
