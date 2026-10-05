import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import readers from "./task-archive.readers.json";

const SRC = join(__dirname, "..");
const ROOT = join(SRC, "..");

const TASK_READ = /\bTask\.(?:find|findOne|findById|aggregate|countDocuments|distinct|exists|findOneAndUpdate)\b/;
const USES_THE_FILTER = /from\s+["']@\/lib\/task-archive["']/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry) ? [path] : [];
  });
}

const reading = sources(SRC)
  .filter((path) => TASK_READ.test(readFileSync(path, "utf8")))
  .map((path) => relative(ROOT, path))
  .sort();

const decided = [...readers.hides, ...Object.keys(readers.sees)];

describe("every reader of tasks has decided what an archived task is to it", () => {
  it("has no file reading tasks that is not in src/lib/task-archive.readers.json", () => {
    expect(
      reading.filter((path) => !decided.includes(path)),
      "These files read tasks. An archived task is hidden by default: add the file to `hides` and spread NOT_ARCHIVED (src/lib/task-archive.ts) into its filter, or to `sees` with the reason it must see archived tasks."
    ).toEqual([]);
  });

  it("lists only files that still read tasks", () => {
    expect(decided.filter((path) => !reading.includes(path))).toEqual([]);
  });

  it("makes every file that hides archived tasks use the shared filter", () => {
    expect(readers.hides.filter((path) => !USES_THE_FILTER.test(readFileSync(join(ROOT, path), "utf8")))).toEqual([]);
  });

  it("lists no file as both", () => {
    expect(readers.hides.filter((path) => path in readers.sees)).toEqual([]);
  });
});
